import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadSettings, scaffoldSettings } from "./src/core/settings";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerMrcReferenceJournalHook } from "./src/hooks/mrc-reference-journal";
import { registerPiMrcCommand } from "./src/commands/pi-mrc";
import { registerPiMrcReportCommand } from "./src/commands/pi-mrc-report";
import { registerDumpContextCommand } from "./src/commands/pi-mrc-dump-context";
import { registerPiMrcControlCommands } from "./src/commands/pi-mrc-control";
import { registerLookupTool } from "./src/tools/lookup";
import { registerCompactionReportCard } from "./src/ui/compaction-report-card";
import { pushContextSlot, pushProviderRequestSlot } from "./src/core/context-buffer";

export default (pi: ExtensionAPI) => {
  scaffoldSettings();

  // Always buffer real context for dump/mrc use.
  pi.on("context", (event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    pushContextSlot(sessionFile, {
      timestamp: new Date().toISOString(),
      messages: event.messages as unknown[],
    });
  });

  // When debug mode is enabled, also buffer the final provider payload so users
  // can audit what Pi sends after context conversion and provider shaping.
  pi.on("before_provider_request", (event, ctx) => {
    if (!loadSettings().debug) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    pushProviderRequestSlot(sessionFile, {
      timestamp: new Date().toISOString(),
      payload: event.payload,
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
