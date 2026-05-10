import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { getSessionStrategy } from "../commands/pi-vcc-strategy";
import { loadSettings } from "../core/settings";
import {
  buildMrcReferenceAnchorDetails,
  buildMrcReferenceJournal,
  PI_VCC_MRC_ANCHOR_TYPE,
  PI_VCC_MRC_REFERENCES_STATE_TYPE,
  renderEphemeralMrcRefs,
  renderMrcReferenceAnchor,
} from "../core/mrc-reference-journal";

const shouldJournalReferences = (): boolean => {
  if (getSessionStrategy() === "off") return false;
  if (getSessionStrategy() === "model-reference") return true;
  return loadSettings().strategy === "model-reference";
};

const latestUserTurn = (messages: any[]): any[] => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages.slice(i);
  }
  return messages;
};

export const registerMrcReferenceJournalHook = (pi: ExtensionAPI) => {
  pi.on("context", (event, ctx) => {
    if (!shouldJournalReferences()) return;
    const content = renderEphemeralMrcRefs(ctx.sessionManager.getBranch(), 8, event.messages as any[]);
    if (!content) return;
    return {
      messages: [
        ...(event.messages as any[]),
        {
          role: "user",
          content: [{ type: "text", text: content }],
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("agent_end", async (event) => {
    if (!shouldJournalReferences()) return;
    const messages = convertToLlm(latestUserTurn(event.messages as any[]));
    const journal = buildMrcReferenceJournal(messages, { maxRefs: 8 });
    if (!journal) return;

    pi.appendEntry(PI_VCC_MRC_REFERENCES_STATE_TYPE, journal);
    const anchor = renderMrcReferenceAnchor(journal, 8);
    if (!anchor) return;
    pi.sendMessage({
      customType: PI_VCC_MRC_ANCHOR_TYPE,
      content: anchor,
      display: false,
      details: buildMrcReferenceAnchorDetails(journal),
    });
  });
};
