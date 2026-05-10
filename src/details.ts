import type { PiVccCompactionReport } from "./core/compaction-report";
import type { MrcReferenceJournalDetails } from "./core/mrc-reference-journal";

export interface PiVccCompactionDetails {
  compactor: "pi-vcc";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  report?: PiVccCompactionReport;
  modelReferenceIndex?: MrcReferenceJournalDetails;
}
