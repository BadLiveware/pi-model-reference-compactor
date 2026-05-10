import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

let sessionDisabled = false;

export const isPiMrcDisabled = () => sessionDisabled;

export const registerPiMrcControlCommands = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-mrc-off", {
    description: "Disable pi-mrc compaction interception for this session",
    handler: async (_args, ctx) => {
      sessionDisabled = true;
      ctx.ui.notify("pi-mrc disabled for this session. Pi's built-in compactor will handle /compact and auto-compaction.", "info");
    },
  });

  pi.registerCommand("pi-mrc-on", {
    description: "Enable pi-mrc compaction interception for this session",
    handler: async (_args, ctx) => {
      sessionDisabled = false;
      ctx.ui.notify("pi-mrc enabled for this session.", "info");
    },
  });
};
