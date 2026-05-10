import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  formatCompactionReportCard,
  formatCompactionReportSummaryLine,
  PI_MRC_COMPACTION_REPORT_TYPE,
  type PiMrcCompactionReport,
} from "./compaction-report";
import type { PiMrcCompactionDetails } from "../details";

export const PI_MRC_REPORT_COMMAND_TYPE = "pi-mrc-report";

export interface CompactionReportRecord {
  entryId: string;
  entryIds: string[];
  entryType: "compaction" | "custom_message" | "message";
  timestamp?: string;
  report: PiMrcCompactionReport;
}

export interface CompactionReportArtifacts {
  markdownPath: string;
  jsonPath: string;
}

export const isPiMrcCompactionReport = (value: unknown): value is PiMrcCompactionReport => {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<PiMrcCompactionReport>;
  return report.compactor === "pi-mrc"
    && report.version === 1
    && Array.isArray(report.sections)
    && typeof report.sourceMessageCount === "number"
    && typeof report.keptMessageCount === "number"
    && typeof report.tokensBefore === "number"
    && typeof report.summaryChars === "number";
};

const isPiMrcDetails = (value: unknown): value is PiMrcCompactionDetails =>
  typeof value === "object" && value !== null && (value as PiMrcCompactionDetails).compactor === "pi-mrc";

const recordKeyOf = (record: CompactionReportRecord): string =>
  JSON.stringify({
    sourceMessageCount: record.report.sourceMessageCount,
    keptMessageCount: record.report.keptMessageCount,
    tokensBefore: record.report.tokensBefore,
    summaryChars: record.report.summaryChars,
    firstChangedLayer: record.report.firstChangedLayer,
    sections: record.report.sections.map((section) => [section.name, section.status, section.itemCount, section.chars]),
  });

export const findCompactionReportRecords = (entries: any[]): CompactionReportRecord[] => {
  const records: CompactionReportRecord[] = [];

  for (const entry of entries) {
    if (entry?.type === "compaction" && isPiMrcDetails(entry.details) && isPiMrcCompactionReport(entry.details.report)) {
      records.push({
        entryId: String(entry.id ?? ""),
        entryIds: [String(entry.id ?? "")],
        entryType: "compaction",
        timestamp: entry.timestamp,
        report: entry.details.report,
      });
      continue;
    }

    if (entry?.type === "custom_message"
      && entry.customType === PI_MRC_COMPACTION_REPORT_TYPE
      && isPiMrcCompactionReport(entry.details)) {
      records.push({
        entryId: String(entry.id ?? ""),
        entryIds: [String(entry.id ?? "")],
        entryType: "custom_message",
        timestamp: entry.timestamp,
        report: entry.details,
      });
      continue;
    }

    if (entry?.type === "message"
      && entry.message?.role === "custom"
      && entry.message?.customType === PI_MRC_COMPACTION_REPORT_TYPE
      && isPiMrcCompactionReport(entry.message?.details)) {
      records.push({
        entryId: String(entry.id ?? ""),
        entryIds: [String(entry.id ?? "")],
        entryType: "message",
        timestamp: entry.timestamp,
        report: entry.message.details,
      });
    }
  }

  const deduped = new Map<string, CompactionReportRecord>();
  for (const record of records) {
    const key = recordKeyOf(record);
    const previous = deduped.get(key);
    deduped.set(key, previous
      ? { ...record, entryIds: [...previous.entryIds, ...record.entryIds] }
      : record);
  }
  return [...deduped.values()];
};

export const latestCompactionReportRecord = (entries: any[]): CompactionReportRecord | undefined => {
  const records = findCompactionReportRecords(entries);
  return records[records.length - 1];
};

export const selectCompactionReportRecord = (
  records: CompactionReportRecord[],
  entryId?: string,
): CompactionReportRecord | undefined => {
  if (!entryId) return records[records.length - 1];
  return records.find((record) => record.entryId === entryId || record.entryIds.includes(entryId));
};

const safeId = (entryId: string): string =>
  entryId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "latest";

export const writeCompactionReportArtifacts = (record: CompactionReportRecord): CompactionReportArtifacts => {
  const dir = join(tmpdir(), "pi-mrc-reports");
  mkdirSync(dir, { recursive: true });
  const base = `pi-mrc-report-${safeId(record.entryId)}`;
  const markdownPath = join(dir, `${base}.md`);
  const jsonPath = join(dir, `${base}.json`);

  writeFileSync(markdownPath, `${formatCompactionReportCard(record.report, { expanded: true })}\n`, "utf-8");
  writeFileSync(jsonPath, `${JSON.stringify(record.report, null, 2)}\n`, "utf-8");
  return { markdownPath, jsonPath };
};

export const formatCompactionReportRecordList = (records: CompactionReportRecord[], limit = 10): string => {
  if (records.length === 0) return "No pi-mrc compaction reports found in this session.";
  const recent = records.slice(-limit);
  const lines = [
    `pi-mrc compaction reports (${records.length} found, showing ${recent.length})`,
    "",
  ];
  for (const [index, record] of recent.entries()) {
    lines.push([
      `${records.length - recent.length + index + 1}.`,
      record.timestamp ?? "unknown-time",
      `[${record.entryType}:${record.entryId}]`,
      formatCompactionReportSummaryLine(record.report),
    ].join(" "));
  }
  return lines.join("\n");
};

export const formatCompactionReportCommandSummary = (
  record: CompactionReportRecord,
  artifacts: CompactionReportArtifacts,
): string => [
  "Latest pi-mrc compaction report",
  "",
  formatCompactionReportSummaryLine(record.report),
  "",
  "Deep dive artifacts",
  `- Markdown: ${artifacts.markdownPath}`,
  `- JSON: ${artifacts.jsonPath}`,
  "",
  `Use /pi-mrc-report show to display the expanded report inline, or /pi-mrc-report json inline to print raw JSON into the session.`,
].join("\n");
