import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const disabledSessions = new Set<string>();

const sessionKeyOf = (ctx: { sessionManager?: { getSessionFile?: () => string | undefined } }): string | undefined =>
  ctx.sessionManager?.getSessionFile?.();

export const isPiMrcDisabled = (sessionFile?: string): boolean =>
  !!sessionFile && disabledSessions.has(sessionFile);

export const registerPiMrcControlCommands = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-mrc-off", {
    description: "Disable pi-mrc compaction interception for this session",
    handler: async (_args, ctx) => {
      const sessionKey = sessionKeyOf(ctx);
      if (!sessionKey) {
        ctx.ui.notify("pi-mrc: No session file available; cannot disable this session.", "warning");
        return;
      }
      disabledSessions.add(sessionKey);
      ctx.ui.notify("pi-mrc disabled for this session. Pi's built-in compactor will handle /compact and auto-compaction.", "info");
    },
  });

  pi.registerCommand("pi-mrc-on", {
    description: "Enable pi-mrc compaction interception for this session",
    handler: async (_args, ctx) => {
      const sessionKey = sessionKeyOf(ctx);
      if (!sessionKey) {
        ctx.ui.notify("pi-mrc: No session file available; cannot enable this session.", "warning");
        return;
      }
      disabledSessions.delete(sessionKey);
      ctx.ui.notify("pi-mrc enabled for this session.", "info");
    },
  });
};
