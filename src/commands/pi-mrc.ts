import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getLastCompactionStats, PI_MRC_COMPACT_INSTRUCTION } from "../hooks/before-compact";

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

export const registerPiMrcCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-mrc", {
    description: "Compact conversation with pi-mrc model-reference compaction",
    handler: async (_args, ctx) => {
      ctx.compact({
        customInstructions: PI_MRC_COMPACT_INSTRUCTION,
        onComplete: () => {
          const stats = getLastCompactionStats();
          if (stats) {
            ctx.ui.notify(
              `pi-mrc: ${stats.summarized} source entries processed; tail kept ${stats.kept} (~${formatTokens(stats.keptTokensEst)} tok).`,
              "info",
            );
          } else {
            ctx.ui.notify("Compacted with pi-mrc", "info");
          }
        },
        onError: (err) => {
          if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
            ctx.ui.notify("Nothing to compact", "warning");
          } else {
            ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
          }
        },
      });
    },
  });
};
