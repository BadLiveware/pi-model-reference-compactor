import type { NormalizedBlock } from "../types";
import { clip, clipSentence, nonEmptyLines } from "./content";
import { summarizeToolResultForPrompt } from "./tool-result-summary";
import type { SectionData } from "../sections";
import { extractGoalState } from "../extract/goals";
import { extractFiles } from "../extract/files";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../extract/preferences";
import { extractCommits, formatCommits } from "../extract/commits";
import { extractEvidence, formatEvidence } from "../extract/evidence";
import { buildBriefSections, sectionsToTranscript, stringifyBrief } from "./brief";
import { extractPath } from "./tool-args";

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
}

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
  const items: string[] = [];
  const tail = blocks.slice(-20);

  for (const b of tail) {
    if (b.kind === "tool_result" && b.isError) {
      items.push(`[${b.name}] ${summarizeToolResultForPrompt(b.text)}`);
      continue;
    }

    if (b.kind === "assistant" || b.kind === "user") {
      for (const line of nonEmptyLines(b.text)) {
        if (!BLOCKER_RE.test(line)) continue;
        if (line.length < 15) continue;
        // Skip continuation fragments (sub-bullets, parentheticals, dangling clauses)
        if (/^\s*[-*+>]\s/.test(line)) continue;
        if (/^\s*\(/.test(line)) continue;
        // Require sentence-like start: capital letter, code identifier, or quote
        if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;
        const clipped = b.kind === "user" ? `[user] ${clipSentence(line, 150)}` : clipSentence(line, 150);
        if (!items.includes(clipped)) items.push(clipped);
        break;
      }
    }
  }

  return items.slice(0, 5);
};

const formatFileActivity = (blocks: NormalizedBlock[]): string[] => {
  const act = extractFiles(blocks);
  // Dedup: if already Modified, drop from Created (file existed before)
  for (const p of act.modified) act.created.delete(p);
  const lines: string[] = [];
  const cap = (set: Set<string>, limit: number) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + " (+more)";
  };
  if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified, 10)}`);
  if (act.created.size > 0) lines.push(`Created: ${cap(act.created, 10)}`);
  if (act.read.size > 0) lines.push(`Read: ${cap(act.read, 10)}`);
  return lines;
};

const READ_TOOLS = new Set(["Read", "read", "read_file", "View"]);

const readLineScore = (line: string): number => {
  let score = 0;
  if (/\b(createRequire|register[A-Z]\w*|supports\w+|handler|schema|strategy|compactor)\b/.test(line)) score += 5;
  if (/\bexport\s+(function|class|const|interface|type)\b/.test(line)) score += 3;
  if (/^import\b/.test(line)) score += 1;
  if (/\b(return|if|else)\b/.test(line)) score += 1;
  return score;
};

const importantReadLines = (text: string): string[] => {
  const candidates = text
    .split("\n")
    .map((line, order) => ({ line: line.trim(), order }))
    .filter((candidate) => candidate.line)
    .map((candidate) => ({ ...candidate, score: readLineScore(candidate.line) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 4)
    .sort((a, b) => a.order - b.order);
  return candidates.map((candidate) => clip(candidate.line, 110));
};

const readContextScore = (path: string, lines: string[]): number => {
  let score = 0;
  if (/\b(loader|resolver|runtime|hook|strategy|compactor|session|auth|cache)\b/i.test(path)) score += 2;
  if (/\b(generated|fixture|snapshot|noise)\b/i.test(path)) score -= 4;
  const text = lines.join("\n");
  if (/\b(register[A-Z]\w*|createRequire|supports\w+|handler|schema|strategy|compactor)\b/.test(text)) score += 3;
  if (/\b(export function|export class|export const|interface|type )\b/.test(text)) score += 1;
  return score;
};

const extractReadContext = (blocks: NormalizedBlock[]): string[] => {
  const readResults: { path: string; lines: string[]; score: number; order: number }[] = [];
  const pendingReadPaths: string[] = [];

  for (const [index, block] of blocks.entries()) {
    if (block.kind === "tool_call") {
      if (READ_TOOLS.has(block.name)) {
        const path = extractPath(block.args);
        if (path) pendingReadPaths.push(path);
      }
      continue;
    }
    if (block.kind !== "tool_result" || !READ_TOOLS.has(block.name)) continue;
    const readPath = pendingReadPaths.shift();
    if (!readPath || block.isError) continue;
    const lines = importantReadLines(block.text);
    if (lines.length === 0) continue;
    const score = readContextScore(readPath, lines);
    if (score <= 0) continue;
    readResults.push({ path: readPath, lines, score, order: index });
  }

  return readResults
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 4)
    .sort((a, b) => a.order - b.order)
    .map((result) => `${result.path}: ${clip(result.lines.join("; "), 220)}`);
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  const briefSections = buildBriefSections(blocks);
  const goalState = extractGoalState(blocks);
  const userPreferences = dedupPreferencesAgainstGoals(
    extractPreferences(blocks),
    [...goalState.stableGoals, ...goalState.currentScope],
  );
  return {
    sessionGoal: goalState.stableGoals,
    currentScope: goalState.currentScope,
    outstandingContext: extractOutstandingContext(blocks),
    filesAndChanges: formatFileActivity(blocks),
    readContext: extractReadContext(blocks),
    commits: formatCommits(extractCommits(blocks)),
    evidenceHandles: formatEvidence(extractEvidence(blocks)),
    userPreferences,
    briefTranscript: stringifyBrief(briefSections),
    transcriptEntries: sectionsToTranscript(briefSections),
  };
};
