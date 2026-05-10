import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "fs";
import {
  findCompactionReportRecords,
  formatCompactionReportCommandSummary,
  formatCompactionReportRecordList,
  PI_MRC_REPORT_COMMAND_TYPE,
  selectCompactionReportRecord,
  writeCompactionReportArtifacts,
} from "../core/compaction-report-history";
import { formatCompactionReportCard } from "../core/compaction-report";

const parseSessionFileEntries = (sessionFile: string | undefined): any[] => {
  if (!sessionFile) return [];
  try {
    return readFileSync(sessionFile, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line); } catch { return undefined; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

const sessionEntriesOf = (ctx: any): any[] => {
  try {
    const entries = ctx.sessionManager.getEntries?.();
    if (Array.isArray(entries) && entries.length > 0) return entries;
  } catch {
    // Defensive fallback: session managers from older Pi versions or partially
    // loaded sessions can throw; the JSONL parser below still gives a report view.
  }
  return parseSessionFileEntries(ctx.sessionManager.getSessionFile?.());
};

const entryIdFromArgs = (args: string): string | undefined =>
  args.match(/\bentry:([^\s]+)/i)?.[1];

export const registerPiMrcReportCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-mrc-report", {
    description: "Inspect latest pi-mrc compaction report; args: list, show, json, entry:<id>",
    handler: async (args: string, ctx) => {
      const raw = args.trim();
      const lower = raw.toLowerCase();
      const records = findCompactionReportRecords(sessionEntriesOf(ctx));

      if (lower.includes("list")) {
        pi.sendMessage({
          customType: PI_MRC_REPORT_COMMAND_TYPE,
          content: formatCompactionReportRecordList(records),
          display: true,
        });
        return;
      }

      const entryId = entryIdFromArgs(raw);
      const record = selectCompactionReportRecord(records, entryId);
      if (!record) {
        const suffix = entryId ? ` for entry ${entryId}` : "";
        ctx.ui.notify(`No pi-mrc compaction report found${suffix}.`, "warning");
        return;
      }

      if (lower.includes("json") && lower.includes("inline")) {
        pi.sendMessage({
          customType: PI_MRC_REPORT_COMMAND_TYPE,
          content: `\`\`\`json\n${JSON.stringify(record.report, null, 2)}\n\`\`\``,
          display: true,
          details: record.report,
        });
        return;
      }

      if (lower.includes("show") || lower.includes("inline")) {
        pi.sendMessage({
          customType: PI_MRC_REPORT_COMMAND_TYPE,
          content: formatCompactionReportCard(record.report, { expanded: true }),
          display: true,
          details: record.report,
        });
        return;
      }

      const artifacts = writeCompactionReportArtifacts(record);
      pi.sendMessage({
        customType: PI_MRC_REPORT_COMMAND_TYPE,
        content: formatCompactionReportCommandSummary(record, artifacts),
        display: true,
        details: { report: record.report, artifacts },
      });
    },
  });
};
