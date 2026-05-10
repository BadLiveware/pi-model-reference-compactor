/**
 * Chunk model for the model-reference compactor.
 *
 * Splits compaction state into referenceable chunks, each with a stable ID
 * that survives across compactions. The model classifies these chunks into
 * KEEP (active prompt), REF (retrievable index), or DROP (archive only).
 */

import type { CompactionState } from "./compaction-state";

export type ChunkKind =
  | "goal"
  | "scope"
  | "recent-scope"
  | "file"
  | "read-context"
  | "commit"
  | "recent-commit"
  | "evidence"
  | "recent-evidence"
  | "preference"
  | "recent-preference"
  | "outstanding-context"
  | "transcript-line"
  | "recall";

export interface CompactionChunk {
  /** Stable ID, e.g. "goal:0", "evidence:2", "transcript:15" */
  id: string;
  kind: ChunkKind;
  /** Full text content, preserved verbatim when in KEEP tier */
  text: string;
  /** Source section name for reconstruction */
  section: string;
  /** 0-based index within the section */
  index: number;
}

/**
 * Build chunks from a CompactionState.
 *
 * Each section item becomes one chunk. Transcript lines are split per line.
 * Chunk IDs use the pattern `section:index` and are stable as long as
 * the section's items retain their identity across compactions.
 */
export const chunkCompactionState = (state: CompactionState): CompactionChunk[] => {
  const chunks: CompactionChunk[] = [];

  const items = (
    kind: ChunkKind,
    section: string,
    source: string[],
  ): void => {
    for (let i = 0; i < source.length; i++) {
      chunks.push({ id: `${section}:${i}`, kind, text: source[i], section, index: i });
    }
  };

  items("goal", "sessionGoal", state.current.sessionGoal);
  items("scope", "currentScope", state.current.currentScope);
  items("recent-scope", "recentScope", state.current.recentScopeUpdates);
  items("file", "files", state.current.filesAndChanges);
  items("read-context", "readContext", state.current.readContext);
  items("commit", "commits", state.current.commits);
  items("recent-commit", "recentCommits", state.current.recentCommits);
  items("evidence", "evidence", state.current.evidenceHandles);
  items("recent-evidence", "recentEvidence", state.current.recentEvidenceHandles);
  items("preference", "preferences", state.current.userPreferences);
  items("recent-preference", "recentPreferences", state.current.recentUserPreferences);
  items("outstanding-context", "outstanding", state.current.outstandingContext);

  // Transcript lines
  const transcriptLines = state.history.briefTranscript
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (let i = 0; i < transcriptLines.length; i++) {
    chunks.push({
      id: `transcript:${i}`,
      kind: "transcript-line",
      text: transcriptLines[i],
      section: "transcript",
      index: i,
    });
  }

  return chunks;
};

export interface SubGoal {
  status: "CURRENT" | "UPCOMING" | "DEFERRED" | "COMPLETED";
  label: string;
  recallCondition: string;
  ref: string;  // chunk IDs or bundle:name
}

/** Classification result from the model */
export interface ChunkClassification {
  keepIds: string[];
  refs: Array<{ id: string; summary: string }>;
  dropIds: string[];
  mvs: string;
  overarching?: string;
  subGoals?: SubGoal[];
  /** Parked goal bundles for later revival */
  bundles?: GoalBundle[];
}

/** A parked goal context bundle */
export interface GoalBundle {
  id: string;
  label: string;
  recallCondition: string;
  chunkIds: string[];
}

/** A single REF index entry stored in Tier 2 */
export interface RefIndexEntry {
  id: string;
  summary: string;
  /** Compaction cycle when this was last classified as REF */
  cycle: number;
  /** Times this chunk has been promoted from REF to KEEP */
  promotionCount: number;
}

/** Tier 2 retrievable index */
export interface RefIndex {
  entries: RefIndexEntry[];
}
