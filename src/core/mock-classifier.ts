/**
 * Mock model classifier for benchmarking the model-reference compactor.
 *
 * Classifies chunks into KEEP/REF/DROP using heuristics that approximate
 * what a real model would do: prioritize identifiers, paths, decisions,
 * error signatures, preferences, and goals. Writes one-line REF summaries
 * and a short MVS paragraph.
 *
 * In production, this would be replaced with a real LLM API call.
 */

import type { CompactionChunk, ChunkClassification } from "./chunk-model";

export interface MockModelConfig {
  /** Maximum KEEP chunks to retain (algorithmic cap) */
  maxKeep?: number;
  /** Maximum REF chunks to index (algorithmic cap) */
  maxRef?: number;
  /** Needles the classifier should always keep (for synthetic bench cases) */
  needles?: string[];
  /** Previous classification to inform merging (simulates model context) */
  previousIds?: {
    keepIds: string[];
    refIds: string[];
  };
}

const SCORE = {
  CURRENT_SCOPE: 7,
  ACTIVE_GOAL: 6,
  CONSTRAINT: 6,
  READ_CONTEXT: 5,
  FILE_PATH: 4,
  COMMIT_HASH: 4,
  ERROR_SIGNATURE: 4,
  PREFERENCE: 3,
  DECISION: 3,
  GOAL: 3,
  EVIDENCE_IDENTIFIER: 2,
  TRANSCRIPT_DECISION: 2,
  DEFAULT: 0,
} as const;

const scoreChunk = (chunk: CompactionChunk, needles: string[]): number => {
  const text = chunk.text.toLowerCase();

  // Needles always score high
  for (const needle of needles) {
    if (text.includes(needle.toLowerCase())) return 8;
  }

  if (chunk.kind === "scope" || chunk.kind === "recent-scope" || chunk.kind === "outstanding-context") {
    return SCORE.CURRENT_SCOPE;
  }

  if (chunk.kind === "goal") {
    return SCORE.ACTIVE_GOAL;
  }

  if (/\b(hard constraint|constraint|do not change|must not|without changing|unchanged|preserve|never use|do not paste|without rereading)\b/i.test(text)) {
    return SCORE.CONSTRAINT;
  }

  if (chunk.kind === "transcript-line" && /\b(next|verify|bounded|remains bounded|continue|rerun|document)\b/i.test(text)) {
    return SCORE.CURRENT_SCOPE;
  }

  if (chunk.kind === "read-context" && /\b(createRequire|register[A-Z]\w*|supports\w+|handler|schema|strategy|compactor)\b/i.test(text)) {
    return SCORE.READ_CONTEXT;
  }

  // File paths
  if ((/\b[\w./-]+\.[\w]{1,6}\b/.test(text) || text.includes("/")) && text.length < 120) {
    return SCORE.FILE_PATH;
  }

  // Commit hashes (7-40 hex chars)
  if (/\b[0-9a-f]{7,40}\b/.test(text)) {
    return SCORE.COMMIT_HASH;
  }

  // Error signatures
  if (/\b(ERR_|CACHE_|PROBE_|request_id=|span_id=|trace_id=)/i.test(text)) {
    return SCORE.ERROR_SIGNATURE;
  }

  // Preferences
  if (/\b(prefer|always|never use|don'?t want|please use|please avoid)\b/i.test(text)) {
    return SCORE.PREFERENCE;
  }

  // Decisions
  if (/\b(decision|decided|chose|chosen|agreed|resolved|concluded)\b/i.test(text)) {
    return SCORE.DECISION;
  }

  // Goals / objectives
  if (/\b(goal|objective|task|aim|target|plan to|working on)\b/i.test(text)) {
    return SCORE.GOAL;
  }

  // Evidence handles with identifiers
  if (/\b(request_id|span_id|ERR_|CACHE_|probe|fixture|artifact)\b/i.test(text)) {
    return SCORE.EVIDENCE_IDENTIFIER;
  }

  // Transcript decisions
  if (chunk.kind === "transcript-line" &&
      /\b(fix|implement|add|remove|change|refactor|commit)\b/i.test(text)) {
    return SCORE.TRANSCRIPT_DECISION;
  }

  return SCORE.DEFAULT;
};

const KEEP_THRESHOLD = 3;
const REF_THRESHOLD = 2;

const makeRefSummary = (chunk: CompactionChunk): string => {
  const t = chunk.text.trim();
  // Extract the most useful prefix
  const firstPart = t.slice(0, 120).replace(/\s+/g, " ").trim();
  if (firstPart.length < t.length) return `${firstPart} ...`;
  return firstPart;
};

const makeMVS = (keepChunks: CompactionChunk[], messageCount: number): string => {
  const goals = keepChunks.filter((c) => c.kind === "goal").map((c) => c.text);
  const files = keepChunks.filter((c) => c.kind === "file" || c.kind === "read-context" || c.kind === "evidence").slice(0, 3);
  const commits = keepChunks.filter((c) => c.kind === "commit" || c.kind === "recent-commit").slice(0, 2);

  const parts: string[] = [];
  if (goals.length > 0) {
    parts.push(`Working on: ${goals[0].replace(/\s+/g, " ").trim().slice(0, 140)}`);
  } else {
    parts.push(`Continuing work from ${messageCount} messages of conversation.`);
  }

  if (files.length > 0) {
    parts.push(`Active files: ${files.map((f) => f.text.split(":")[0]?.trim() || f.text.trim()).join(", ")}`);
  }

  if (commits.length > 0) {
    parts.push(`Recent commits include ${commits.map((c) => c.text.trim().slice(0, 40)).join("; ")}`);
  }

  return parts.join(" ");
};

/**
 * Classify chunks using heuristic scoring, simulating what a real model
 * would do but without an API call.
 */
export const mockClassify = (
  chunks: CompactionChunk[],
  messageCount: number,
  config: MockModelConfig = {},
): ChunkClassification => {
  const { maxKeep = 15, maxRef = 10, needles = [], previousIds } = config;
  const prevKeepSet = new Set(previousIds?.keepIds ?? []);
  const prevRefSet = new Set(previousIds?.refIds ?? []);

  // Score each chunk, with bonus for previously kept/referenced chunks
  const scored = chunks.map((chunk) => {
    let score = scoreChunk(chunk, needles);
    // Previous KEEP gets strong bonus (model likely still relevant)
    if (prevKeepSet.has(chunk.id)) score += 2;
    // Previous REF gets mild bonus
    else if (prevRefSet.has(chunk.id)) score += 1;
    return { chunk, score };
  });

  // Sort by score descending, stable tiebreak by id
  scored.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));

  const keep: CompactionChunk[] = [];
  const ref: CompactionChunk[] = [];
  const drop: CompactionChunk[] = [];

  for (const { chunk, score } of scored) {
    if (score >= KEEP_THRESHOLD && keep.length < maxKeep) {
      keep.push(chunk);
    } else if (score >= REF_THRESHOLD && ref.length < maxRef) {
      ref.push(chunk);
    } else {
      drop.push(chunk);
    }
  }

  return {
    keepIds: keep.map((c) => c.id),
    refs: ref.map((c) => ({ id: c.id, summary: makeRefSummary(c) })),
    dropIds: drop.map((c) => c.id),
    mvs: makeMVS(keep, messageCount),
  };
};
