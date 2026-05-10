import type { PiMrcCompactionReport } from "./core/compaction-report";
import type { MrcReferenceJournalDetails } from "./core/mrc-reference-journal";

export interface PiMrcCompactionDetails {
  compactor: "pi-mrc";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  report?: PiMrcCompactionReport;
  modelReferenceIndex?: MrcReferenceJournalDetails;
}
