import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { scaffoldSettings } from "./src/core/settings";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerPiVccReportCommand } from "./src/commands/pi-vcc-report";
import { registerDumpContextCommand } from "./src/commands/pi-vcc-dump-context";
import { registerRecallTool } from "./src/tools/recall";
import { registerCompactionReportCard } from "./src/ui/compaction-report-card";

export default (pi: ExtensionAPI) => {
  scaffoldSettings();
  registerCompactionReportCard(pi);
  registerBeforeCompactHook(pi);
  registerPiVccCommand(pi);
  registerPiVccReportCommand(pi);
  registerDumpContextCommand(pi);
  registerVccRecallCommand(pi);
  registerRecallTool(pi);
};
