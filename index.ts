import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { scaffoldSettings } from "./src/core/settings";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerMrcReferenceJournalHook } from "./src/hooks/mrc-reference-journal";
import { registerPiMrcCommand } from "./src/commands/pi-mrc";
import { registerPiMrcReportCommand } from "./src/commands/pi-mrc-report";
import { registerDumpContextCommand } from "./src/commands/pi-mrc-dump-context";
import { registerPiMrcControlCommands } from "./src/commands/pi-mrc-control";
import { registerLookupTool } from "./src/tools/lookup";
import { registerCompactionReportCard } from "./src/ui/compaction-report-card";
import { pushContextSlot } from "./src/core/context-buffer";

export default (pi: ExtensionAPI) => {
  scaffoldSettings();

  // Always buffer real context for dump/mrc use
  pi.on("context", (event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    pushContextSlot(sessionFile, {
      timestamp: new Date().toISOString(),
      messages: event.messages as unknown[],
    });
  });

  registerCompactionReportCard(pi);
  registerMrcReferenceJournalHook(pi);
  registerBeforeCompactHook(pi);
  registerPiMrcCommand(pi);
  registerPiMrcReportCommand(pi);
  registerDumpContextCommand(pi);
  registerPiMrcControlCommands(pi);
  registerLookupTool(pi);
};
