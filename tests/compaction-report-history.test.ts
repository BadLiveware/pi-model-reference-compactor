import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import type { PiVccCompactionReport } from "../src/core/compaction-report";
import { PI_VCC_COMPACTION_REPORT_TYPE } from "../src/core/compaction-report";
import {
  findCompactionReportRecords,
  formatCompactionReportCommandSummary,
  formatCompactionReportRecordList,
  selectCompactionReportRecord,
  writeCompactionReportArtifacts,
} from "../src/core/compaction-report-history";

const report = (firstChangedLayer = "Pi VCC Recent Scope Updates"): PiVccCompactionReport => ({
  compactor: "pi-vcc",
  version: 1,
  sourceMessageCount: 12,
  keptMessageCount: 2,
  keptTokensEst: 123,
  skippedInternalMessageCount: 0,
  tokensBefore: 4800,
  summaryChars: 900,
  previousSummaryUsed: true,
  firstChangedLayer,
  firstChangedPolicy: "recent-volatile",
  stableSectionCount: 4,
  stableUnchangedCount: 4,
  stableChangedSections: [],
  recentSectionCount: 1,
  cappedSections: [],
  warnings: [],
  sections: [
    {
      name: "Pi VCC Session Goal",
      title: "Session Goal",
      role: "current",
      policy: "stable-current",
      status: "unchanged",
      itemCount: 1,
      renderedItemCount: 1,
      chars: 42,
      reason: "stable",
      preview: ["Build cache-aware compaction"],
    },
    {
      name: firstChangedLayer,
      title: firstChangedLayer.replace(/^Pi VCC /, ""),
      role: "current",
      policy: "recent-volatile",
      status: "new",
      itemCount: 1,
      renderedItemCount: 1,
      chars: 58,
      reason: "recent",
      preview: ["Add report inspection"],
    },
  ],
});

describe("compaction report history", () => {
  test("finds and dedupes reports from compaction and custom report messages", () => {
    const first = report();
    const second = report("Pi VCC Recent Evidence Handles");
    const entries = [
      { id: "c1", type: "compaction", timestamp: "t1", details: { compactor: "pi-vcc", version: 2, report: first } },
      { id: "m1", type: "custom_message", timestamp: "t2", customType: PI_VCC_COMPACTION_REPORT_TYPE, details: first },
      { id: "c2", type: "compaction", timestamp: "t3", details: { compactor: "pi-vcc", version: 2, report: second } },
    ];

    const records = findCompactionReportRecords(entries);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ entryId: "m1", entryIds: ["c1", "m1"], entryType: "custom_message" });
    expect(records[1]).toMatchObject({ entryId: "c2", entryType: "compaction" });
    expect(selectCompactionReportRecord(records, "c1")?.entryId).toBe("m1");
  });

  test("formats list and writes markdown/json deep-dive artifacts", () => {
    const [record] = findCompactionReportRecords([
      { id: "c1", type: "compaction", timestamp: "t1", details: { compactor: "pi-vcc", version: 2, report: report() } },
    ]);

    const artifacts = writeCompactionReportArtifacts(record);
    const list = formatCompactionReportRecordList([record]);
    const summary = formatCompactionReportCommandSummary(record, artifacts);

    expect(list).toContain("pi-vcc compaction reports");
    expect(list).toContain("compaction:c1");
    expect(summary).toContain("Deep dive artifacts");
    expect(summary).toContain(artifacts.markdownPath);
    expect(readFileSync(artifacts.markdownPath, "utf-8")).toContain("Sanity check");
    expect(JSON.parse(readFileSync(artifacts.jsonPath, "utf-8"))).toMatchObject({ compactor: "pi-vcc" });
  });
});
