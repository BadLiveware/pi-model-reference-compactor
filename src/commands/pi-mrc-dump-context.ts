/**
 * /pi-mrc-dump-context command.
 *
 * Extracts a structured context guide from the current session JSONL
 * without triggering any compaction. Writes Markdown by default;
 * supports --raw for JSONL dump and --summary for inline display.
 *
 * Usage:
 *   /pi-mrc-dump-context                          → writes to /tmp/pi-mrc-context-guide.md
 *   /pi-mrc-dump-context /path/to/output.md       → writes to specified path
 *   /pi-mrc-dump-context --raw                    → dumps raw active branch as JSONL
 *   /pi-mrc-dump-context --raw /path/to/out.jsonl → raw JSONL to specified path
 *   /pi-mrc-dump-context --summary               → displays extracted context inline
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import {
  extractContext,
  extractContextFromBuffer,
  formatContextGuide,
  writeContextGuide,
  dumpRawSessionJsonl,
} from "../core/dump-context";

export const registerDumpContextCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-mrc-dump-context", {
    description:
      "Extract structured context guide from session JSONL. Args: [output path] [--raw] [--summary]. No compaction is triggered.",
    handler: async (args: string, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No session file available.", "error");
        return;
      }

      const raw = args.trim();
      const argv = raw.split(/\s+/).filter(Boolean);
      const hasFlag = (flag: string): boolean => argv.includes(flag);
      const isRawContext = hasFlag("--raw-context");
      const isRaw = hasFlag("--raw");
      const isSummary = hasFlag("--summary");

      const pathArg = argv
        .filter((arg) => arg !== "--raw-context" && arg !== "--raw" && arg !== "--summary")
        .join(" ");

      // --raw-context: dump the real context buffer as a formatted document
      if (isRawContext) {
        // Look up buffer for this session
        const { readContextBuffer, listBufferedSessions } = await import("../core/context-buffer");
        const slots = readContextBuffer(sessionFile);
        if (slots.length === 0) {
          const sessions = listBufferedSessions();
          if (sessions.length === 0) {
            ctx.ui.notify("No context buffer found. Prompt the agent at least once first.", "warning");
            return;
          }
          ctx.ui.notify(`No buffer for this session. Available: ${sessions.map((s: any) => s.file).join(", ")}`, "warning");
          return;
        }
        const latest = slots[slots.length - 1];
        const messages = latest?.messages;
        if (!Array.isArray(messages)) {
          ctx.ui.notify("No messages in latest buffer slot.", "warning");
          return;
        }

        // Format messages as a readable context document
        const lines: string[] = [];
        lines.push(`# Real Context Dump`);
        lines.push(`Captured: ${latest.timestamp}`);
        lines.push(`${messages.length} messages`);
        lines.push("");
        for (const m of messages) {
          const role = (m as any).role;
          if (role === "system") continue;
          let text = "";
          if (role === "compactionSummary" || role === "compaction_summary") {
            text = (m as any).summary || "";
          } else {
            const content = (m as any).content;
            if (typeof content === "string") text = content;
            else if (Array.isArray(content)) {
              text = content
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text || "")
                .join(" ");
            }
          }
          if (!text.trim()) continue;
          const prefix = role === "user" ? "## USER" : role === "assistant" ? "### assistant" : `[${role}]`;
          const truncated = text.length > 500 ? text.substring(0, 500) + "..." : text;
          lines.push(`${prefix}\n${truncated}\n`);
        }

        const outPath = pathArg || `/tmp/pi-mrc-raw-context-${Date.now()}.txt`;
        const dir = dirname(outPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(outPath, lines.join("\n"));
        const size = statSync(outPath).size;
        ctx.ui.notify(`Raw context dumped: ${outPath} (${(size / 1024).toFixed(0)} KB, ${slots.length} buffer slots)`, "info");
        return;
      }

      // --raw: dump raw JSONL. This does not require successful context extraction.
      if (isRaw) {
        const outPath = pathArg || undefined;
        const written = dumpRawSessionJsonl(sessionFile, outPath);
        const size = statSync(written).size;
        ctx.ui.notify(`Raw session dumped: ${written} (${(size / 1024).toFixed(0)} KB)`, "info");
        return;
      }

      // Try real context buffer first, fall back to session extraction
      let extracted = extractContextFromBuffer(sessionFile);
      let sourceLabel = "real context buffer";
      if (!extracted) {
        extracted = extractContext(sessionFile);
        sourceLabel = "session file";
      }
      if (!extracted) {
        ctx.ui.notify("Failed to extract context from buffer or session file.", "error");
        return;
      }

      if (isSummary) {
        const guide = formatContextGuide(extracted, sessionFile);
        pi.sendMessage({
          customType: "mrc-context-dump",
          content: guide,
          display: true,
        });
        return;
      }

      // Default: write context guide Markdown
      const outPath = pathArg || undefined;
      const written = writeContextGuide(extracted, sessionFile, outPath);
      const size = statSync(written).size;
      ctx.ui.notify(`Context guide written (${sourceLabel}): ${written} (${(size / 1024).toFixed(1)} KB)`, "info");

      const summary = [
        `Context guide for ${extracted.stats.sessionId} (${sourceLabel})`,
        `  Goals: ${extracted.goal.length}`,
        `  Decisions: ${extracted.decisions.length}`,
        `  Preferences: ${extracted.preferences.length}`,
        `  Modified files: ${extracted.filesModified.size}`,
        `  Recent user messages: ${extracted.recentUserMessages.length}`,
        `  Compaction summaries: ${extracted.compactionSummaries.length}`,
      ];
      pi.sendMessage({
        customType: "mrc-context-dump",
        content: summary.join("\n"),
        display: true,
      });
    },
  });
};
