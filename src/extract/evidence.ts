import type { NormalizedBlock } from "../types";
import { extractPath } from "../core/tool-args";

export interface EvidenceActivity {
  paths: Set<string>;
  identifiers: Set<string>;
  errorSignatures: Set<string>;
}

const ABS_PATH_RE = /(?:^|[\s"'`(=])(\/(?:tmp|var|home|workspace|app|repo|src|tests?)\/[\w./-]+)/g;
const PROJECT_PATH_RE = /(?:^|[\s"'`(=])((?:src|test|tests|scripts|bench)\/[\w./-]+)/g;
const ERROR_SIGNATURE_RE = /\b(?:ERR_[A-Z0-9_]+|(?:CACHE|CRITICAL|FATAL|PANIC|ERROR|FAIL)[A-Z0-9_]*(?:_[A-Z0-9]+)+)\b/g;
const ID_RE = /\b(?:cache|probe|span|spn|req|request|trace|artifact|bench)[A-Za-z0-9_-]*_[A-Za-z0-9_-]+\b/g;
const COMMIT_RE = /\bcommit(?:\s+|[=:])([0-9a-f]{7,40})\b/gi;

const normalizePathEvidence = (value: string): string =>
  value.trim().replace(/[.,;:]+$/, "");

const isSpecificPathEvidence = (value: string): boolean => {
  const normalized = normalizePathEvidence(value);
  if (/^\/tmp\//.test(normalized)) return true;
  const base = normalized.split("/").at(-1) ?? "";
  return /\.[A-Za-z0-9_-]+$/.test(base);
};

const addMatches = (
  set: Set<string>,
  text: string,
  regex: RegExp,
  group = 0,
  normalize: (value: string) => string | null = (value) => value.trim(),
) => {
  for (const match of text.matchAll(regex)) {
    const value = normalize(match[group] ?? match[0]);
    if (value) set.add(value);
  }
};

const textFromBlock = (block: NormalizedBlock): string => {
  if (block.kind === "tool_call") return JSON.stringify(block.args ?? {});
  return "text" in block ? block.text : "";
};

const addEvidenceFromText = (activity: EvidenceActivity, text: string) => {
  addMatches(activity.paths, text, ABS_PATH_RE, 1, (value) => {
    const normalized = normalizePathEvidence(value);
    return isSpecificPathEvidence(normalized) ? normalized : null;
  });
  addMatches(activity.paths, text, PROJECT_PATH_RE, 1, (value) => normalizePathEvidence(value));
  addMatches(activity.errorSignatures, text, ERROR_SIGNATURE_RE);
  addMatches(activity.identifiers, text, ID_RE);
  addMatches(activity.identifiers, text, COMMIT_RE, 1);
};

export const extractEvidence = (blocks: NormalizedBlock[]): EvidenceActivity => {
  const activity: EvidenceActivity = {
    paths: new Set(),
    identifiers: new Set(),
    errorSignatures: new Set(),
  };

  for (const block of blocks) {
    if (block.kind === "tool_call") {
      const path = extractPath(block.args);
      if (path) activity.paths.add(normalizePathEvidence(path));
      for (const key of ["command", "cmd", "query", "path", "file", "file_path", "filePath"]) {
        const value = block.args[key];
        if (typeof value === "string") addEvidenceFromText(activity, value);
      }
      continue;
    }

    addEvidenceFromText(activity, textFromBlock(block));
  }

  return activity;
};

const MAX_EVIDENCE_VALUE_CHARS = 96;
const MAX_EVIDENCE_LINE_CHARS = 220;

const clipEvidenceValue = (value: string): string =>
  value.length <= MAX_EVIDENCE_VALUE_CHARS
    ? value
    : `${value.slice(0, MAX_EVIDENCE_VALUE_CHARS - 3)}...`;

const cap = (set: Set<string>, limit: number): string => {
  const values = [...set].map(clipEvidenceValue);
  const rendered: string[] = [];
  let omitted = values.length > limit;
  for (const value of values.slice(0, limit)) {
    const candidate = [...rendered, value].join(", ");
    if (candidate.length > MAX_EVIDENCE_LINE_CHARS && rendered.length > 0) {
      omitted = true;
      break;
    }
    rendered.push(value);
  }
  if (rendered.length === 0 && values[0]) {
    rendered.push(values[0].slice(0, MAX_EVIDENCE_LINE_CHARS - 10));
    omitted = true;
  }
  return `${rendered.join(", ")}${omitted ? " (+more)" : ""}`;
};

export const formatEvidence = (activity: EvidenceActivity): string[] => {
  const lines: string[] = [];
  if (activity.paths.size > 0) lines.push(`Paths: ${cap(activity.paths, 12)}`);
  if (activity.errorSignatures.size > 0) lines.push(`Error signatures: ${cap(activity.errorSignatures, 12)}`);
  if (activity.identifiers.size > 0) lines.push(`Identifiers: ${cap(activity.identifiers, 16)}`);
  return lines;
};
