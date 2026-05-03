/**
 * Session-level strategy toggle for pi-vcc.
 *
 * /pi-vcc-mr — enables model-reference strategy for this session
 * /pi-vcc    — uses whichever strategy is currently active
 *
 * The strategy resets to default on session restart. No config file needed.
 */

let sessionStrategy: "pi-vcc" | "model-reference" = "pi-vcc";

export const getSessionStrategy = () => sessionStrategy;

export const setSessionStrategy = (s: "pi-vcc" | "model-reference") => {
  sessionStrategy = s;
};

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const registerPiVccMrCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-vcc-mr", {
    description: "Switch to model-reference compaction strategy for this session",
    handler: async (_args, ctx) => {
      setSessionStrategy("model-reference");
      ctx.ui.notify(
        "Model-reference compaction enabled. Run /pi-vcc to compact.",
        "info",
      );
    },
  });

  pi.registerCommand("pi-vcc-pv", {
    description: "Switch to pi-vcc (algorithmic) compaction strategy for this session",
    handler: async (_args, ctx) => {
      setSessionStrategy("pi-vcc");
      ctx.ui.notify("pi-vcc (algorithmic) compaction enabled.", "info");
    },
  });
};
