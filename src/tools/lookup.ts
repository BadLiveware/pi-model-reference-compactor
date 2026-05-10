import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  MRC_REFERENCE_PROMPT_GUIDELINES,
  PI_MRC_REFERENCES_STATE_TYPE,
  type MrcReferenceEntry,
  type MrcReferenceJournalDetails,
} from "../core/mrc-reference-journal";

interface CollectedRef extends MrcReferenceEntry {
  entryId: string;
  entryTimestamp?: string;
}

const normalizeRef = (ref: string): string => ref.trim().replace(/^ref:/, "");

const isJournalDetails = (value: any): value is MrcReferenceJournalDetails =>
  value?.version === 1 && Array.isArray(value.refs);

const collectRefs = (sessionManager: any): CollectedRef[] => {
  const refs: CollectedRef[] = [];
  const entries = sessionManager.getBranch?.() ?? [];
  for (const entry of entries) {
    if (entry?.type === "custom" && entry.customType === PI_MRC_REFERENCES_STATE_TYPE && isJournalDetails(entry.data)) {
      for (const ref of entry.data.refs) {
        refs.push({ ...ref, entryId: String(entry.id), entryTimestamp: entry.timestamp });
      }
    }

    const detailsRefs = entry?.details?.modelReferenceIndex?.refs;
    if (Array.isArray(detailsRefs)) {
      for (const ref of detailsRefs) {
        if (!ref?.id || !ref?.text) continue;
        refs.push({
          id: String(ref.id),
          kind: ref.kind ?? "recall",
          text: String(ref.text),
          summary: String(ref.summary ?? ref.text).slice(0, 160),
          source: "compaction",
          createdAt: String(ref.createdAt ?? entry.timestamp ?? ""),
          entryId: String(entry.id),
          entryTimestamp: entry.timestamp,
        });
      }
    }
  }
  return refs;
};

const renderSummary = (refs: CollectedRef[]): string =>
  refs.map((ref) => `- ref:${ref.id} — ${ref.summary}`).join("\n");

const renderFull = (refs: CollectedRef[]): string =>
  refs.map((ref) => [
    `## ref:${ref.id}`,
    `kind: ${ref.kind}`,
    `source: ${ref.source}`,
    ref.entryTimestamp ? `entry: ${ref.entryId} @ ${ref.entryTimestamp}` : `entry: ${ref.entryId}`,
    `summary: ${ref.summary}`,
    "",
    ref.text,
  ].join("\n")).join("\n\n---\n\n");

export const registerLookupTool = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "mrc_lookup",
    label: "MRC Lookup",
    description:
      "Resolve exact MRC reference chunks by ref handle. Use this only when the prompt contains ref:* handles " +
      "or exact hidden MRC chunk bodies are needed; this is not fuzzy transcript search.",
    promptSnippet:
      "mrc_lookup: Resolve exact hidden MRC reference chunks by ref handle; do not expose handles to users unless asked.",
    promptGuidelines: MRC_REFERENCE_PROMPT_GUIDELINES,
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: "Reference handle such as 'ref:evidence:abc123' or 'evidence:abc123'." })),
      list: Type.Optional(Type.Boolean({ description: "List recent reference handles without expanding full bodies." })),
      limit: Type.Optional(Type.Number({ description: "Maximum results for list. Default 8." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const refs = collectRefs(ctx.sessionManager);
      const limit = Math.max(1, Math.min(25, params.limit ?? 8));

      if (params.list) {
        const recent = refs.slice(-limit).reverse();
        const text = recent.length > 0
          ? `Recent MRC refs:\n${renderSummary(recent)}`
          : "No MRC references found in the active lineage.";
        return { content: [{ type: "text", text }], details: { matches: recent } };
      }

      if (params.ref?.trim()) {
        const wanted = normalizeRef(params.ref);
        const matches = refs.filter((ref) => ref.id === wanted || `ref:${ref.id}` === params.ref?.trim());
        const text = matches.length > 0
          ? renderFull(matches)
          : `No MRC reference found for ref:${wanted} in the active lineage.`;
        return { content: [{ type: "text", text }], details: { matches } };
      }

      const recent = refs.slice(-limit).reverse();
      const text = recent.length > 0
        ? `Recent MRC refs:\n${renderSummary(recent)}`
        : "No MRC references found in the active lineage.";
      return { content: [{ type: "text", text }], details: { matches: recent } };
    },
  });
};
