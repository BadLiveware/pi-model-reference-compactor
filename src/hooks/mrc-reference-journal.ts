import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { getSessionStrategy } from "../commands/pi-vcc-strategy";
import { loadSettings } from "../core/settings";
import {
  buildMrcReferenceJournal,
  PI_VCC_MRC_REFERENCES_TYPE,
  renderMrcReferenceJournalContent,
} from "../core/mrc-reference-journal";

const shouldJournalReferences = (): boolean => {
  if (getSessionStrategy() === "off") return false;
  if (getSessionStrategy() === "model-reference") return true;
  return loadSettings().strategy === "model-reference";
};

export const registerMrcReferenceJournalHook = (pi: ExtensionAPI) => {
  pi.on("agent_end", async (event) => {
    if (!shouldJournalReferences()) return;
    const messages = convertToLlm(event.messages as any[]);
    const journal = buildMrcReferenceJournal(messages, { maxRefs: 8 });
    if (!journal) return;

    pi.sendMessage({
      customType: PI_VCC_MRC_REFERENCES_TYPE,
      content: renderMrcReferenceJournalContent(journal),
      display: false,
      details: journal,
    });
  });
};
