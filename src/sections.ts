import type { TranscriptEntry } from "./core/brief";

export interface SectionData {
  sessionGoal: string[];
  currentScope: string[];
  outstandingContext: string[];
  filesAndChanges: string[];
  readContext: string[];
  commits: string[];
  evidenceHandles: string[];
  userPreferences: string[];
  briefTranscript: string;
  /** Structured transcript entries (verbose object format) */
  transcriptEntries: TranscriptEntry[];
}
