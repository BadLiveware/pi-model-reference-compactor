import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { isPiMrcDisabled } from "../commands/pi-mrc-control";
import {
  buildMrcReferenceAnchorDetails,
  buildMrcReferenceJournal,
  PI_MRC_ANCHOR_TYPE,
  PI_MRC_REFERENCES_STATE_TYPE,
  PI_MRC_REFERENCES_TYPE,
  insertBeforeLatestUserMessage,
  renderEphemeralMrcRefs,
  renderMrcReferenceAnchor,
} from "../core/mrc-reference-journal";

const shouldJournalReferences = (sessionFile?: string): boolean => !isPiMrcDisabled(sessionFile);

const latestUserTurn = (messages: any[]): any[] => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages.slice(i);
  }
  return messages;
};

export const registerMrcReferenceJournalHook = (pi: ExtensionAPI) => {
  pi.on("context", (event, ctx) => {
    if (!shouldJournalReferences(ctx.sessionManager.getSessionFile())) return;
    const content = renderEphemeralMrcRefs(ctx.sessionManager.getBranch(), 8, event.messages as any[]);
    if (!content) return;
    const message = {
      role: "custom",
      customType: PI_MRC_REFERENCES_TYPE,
      content,
      display: false,
      timestamp: Date.now(),
    };
    return { messages: insertBeforeLatestUserMessage(event.messages as any[], message) };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!shouldJournalReferences(ctx.sessionManager.getSessionFile())) return;
    const messages = convertToLlm(latestUserTurn(event.messages as any[]));
    const journal = buildMrcReferenceJournal(messages, { maxRefs: 8 });
    if (!journal) return;

    pi.appendEntry(PI_MRC_REFERENCES_STATE_TYPE, journal);
    const anchor = renderMrcReferenceAnchor(journal, 8);
    if (!anchor) return;
    pi.sendMessage({
      customType: PI_MRC_ANCHOR_TYPE,
      content: anchor,
      display: false,
      details: buildMrcReferenceAnchorDetails(journal),
    });
  });
};
