/**
 * /pi-vcc-dump-context command.
 *
 * Extracts a structured context guide from the current session JSONL
 * without triggering any compaction. Writes Markdown by default;
 * supports --raw for JSONL dump and --summary for inline display.
 *
 * Usage:
 *   /pi-vcc-dump-context                          → writes to /tmp/pi-vcc-context-guide.md
 *   /pi-vcc-dump-context /path/to/output.md       → writes to specified path
 *   /pi-vcc-dump-context --raw                    → dumps raw active branch as JSONL
 *   /pi-vcc-dump-context --raw /path/to/out.jsonl → raw JSONL to specified path
 *   /pi-vcc-dump-context --summary               → displays extracted context inline
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { statSync } from "fs";
import {
  extractContext,
  formatContextGuide,
  writeContextGuide,
  dumpRawSessionJsonl,
} from "../core/dump-context";

export const registerDumpContextCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-vcc-dump-context", {
    description:
      "Extract structured context guide from session JSONL. Args: [output path] [--raw] [--summary]. No compaction is triggered.",
    handler: async (args: string, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No session file available.", "error");
        return;
      }

      const raw = args.trim();
      const isRaw = raw.includes("--raw");
      const isSummary = raw.includes("--summary");

      // Extract output path from args (strip flags)
      const pathArg = raw
        .replace(/--raw/g, "")
        .replace(/--summary/g, "")
        .trim();

      // --summary: display inline
      if (isSummary) {
        const extracted = extractContext(sessionFile);
        if (!extracted) {
          ctx.ui.notify("Failed to extract context from session file.", "error");
          return;
        }
        const guide = formatContextGuide(extracted, sessionFile);
        pi.sendMessage({
          customType: "vcc-context-dump",
          content: guide,
          display: true,
        });
        return;
      }

      // --raw: dump raw JSONL
      if (isRaw) {
        const outPath = pathArg || undefined;
        const written = dumpRawSessionJsonl(sessionFile, outPath);
        const size = statSync(written).size;
        ctx.ui.notify(
          `Raw session dumped: ${written} (${(size / 1024).toFixed(0)} KB)`,
          "info",
        );
        return;
      }

      // Default: write context guide Markdown
      const extracted = extractContext(sessionFile);
      if (!extracted) {
        ctx.ui.notify("Failed to extract context from session file.", "error");
        return;
      }

      const outPath = pathArg || undefined;
      const written = writeContextGuide(extracted, sessionFile, outPath);
      const size = statSync(written).size;
      ctx.ui.notify(
        `Context guide written: ${written} (${(size / 1024).toFixed(1)} KB)`,
        "info",
      );

      const summary = [
        `Context guide for ${extracted.stats.sessionId}`,
        `  Goals: ${extracted.goal.length}`,
        `  Decisions: ${extracted.decisions.length}`,
        `  Preferences: ${extracted.preferences.length}`,
        `  Modified files: ${extracted.filesModified.size}`,
        `  Recent user messages: ${extracted.recentUserMessages.length}`,
        `  Compaction summaries: ${extracted.compactionSummaries.length}`,
      ];
      pi.sendMessage({
        customType: "vcc-context-dump",
        content: summary.join("\n"),
        display: true,
      });
    },
  });
};
