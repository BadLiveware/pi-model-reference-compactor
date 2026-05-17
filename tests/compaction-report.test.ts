import { describe, expect, test } from "bun:test";
import {
  buildCompactionReport,
  formatCompactionReportCard,
  formatCompactionReportMessageContent,
} from "../src/core/compaction-report";
import { parseCompactionState, renderCompactionState } from "../src/core/compaction-state";

const reportFor = (previousSummary: string | undefined, currentSummary: string) => {
  const state = parseCompactionState(currentSummary);
  const rendered = renderCompactionState(state, { includeRecallNote: true });
  const previousLayers = previousSummary
    ? renderCompactionState(parseCompactionState(previousSummary), { includeRecallNote: true }).layers
    : [];
  return buildCompactionReport({
    layers: rendered.layers,
    previousLayers,
    state,
    sourceMessageCount: 12,
    keptMessageCount: 3,
    keptTokensEst: 240,
    tokensBefore: 4800,
    previousSummaryUsed: Boolean(previousSummary),
    summaryText: rendered.text,
  });
};

describe("compaction report", () => {
  test("identifies recent-only churn after stable current sections", () => {
    const previous = [
      "[Session Goal]",
      "- Build cache-aware compaction",
      "",
      "[Current Scope]",
      "- Make compaction inspectable",
    ].join("\n");
    const current = [
      previous,
      "",
      "[Recent Scope Updates]",
      "- Add a separate pi-vcc report card",
    ].join("\n");

    const report = reportFor(previous, current);

    expect(report.firstChangedLayer).toBe("Pi VCC Recent Scope Updates");
    expect(report.firstChangedPolicy).toBe("recent-volatile");
    expect(report.stableUnchangedCount).toBe(2);
    expect(report.stableChangedSections).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  test("reports caps for bounded recent sections", () => {
    const current = [
      "[Session Goal]",
      "- Build cache-aware compaction",
      "",
      "[Recent Evidence Handles]",
      ...Array.from({ length: 10 }, (_, i) => `- Paths: /tmp/evidence-${i}.json`),
    ].join("\n");

    const report = reportFor(undefined, current);

    expect(report.cappedSections).toEqual([{ section: "Recent Evidence Handles", before: 10, after: 8, dropped: 2 }]);
    expect(report.warnings).toContain("Recent Evidence Handles capped from 10 to 8 items");
    const recentEvidence = report.sections.find((section) => section.title === "Recent Evidence Handles");
    expect(recentEvidence?.itemCount).toBe(10);
    expect(recentEvidence?.renderedItemCount).toBe(8);
  });

  test("formats a concise card with a machine-readable deep-dive hint", () => {
    const current = [
      "[Session Goal]",
      "- Build cache-aware compaction",
    ].join("\n");

    const report = reportFor(undefined, current);
    const content = formatCompactionReportMessageContent(report);
    const expanded = formatCompactionReportCard(report, { expanded: true });

    expect(content).toContain("Compacted 12 messages");
    expect(content).toContain("stored on this UI message");
    expect(expanded).toContain("Sanity check");
    expect(expanded).toContain("Deep dive");
    expect(expanded).toContain("compaction.details.report");
    expect(expanded).toContain("/pi-vcc-report");
  });
});
