import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { scaffoldSettings } from "./src/core/settings";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerPiVccReportCommand } from "./src/commands/pi-vcc-report";
import { registerDumpContextCommand } from "./src/commands/pi-vcc-dump-context";
import { registerRecallTool } from "./src/tools/recall";
import { registerCompactionReportCard } from "./src/ui/compaction-report-card";
import { pushContextSlot } from "./src/core/context-buffer";

export default (pi: ExtensionAPI) => {
  scaffoldSettings();

  // Always buffer real context for dump/mrc use
  pi.on("context", (event) => {
    pushContextSlot({
      timestamp: new Date().toISOString(),
      messages: event.messages as unknown[],
    });
  });

  registerCompactionReportCard(pi);
  registerBeforeCompactHook(pi);
  registerPiVccCommand(pi);
  registerPiVccReportCommand(pi);
  registerDumpContextCommand(pi);
  registerVccRecallCommand(pi);
  registerRecallTool(pi);
};
