import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  PI_VCC_MRC_REFERENCES_TYPE,
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

const entriesForScope = (sessionManager: any, scope: "lineage" | "all"): any[] => {
  if (scope === "all") return sessionManager.getEntries?.() ?? sessionManager.getBranch?.() ?? [];
  return sessionManager.getBranch?.() ?? sessionManager.getEntries?.() ?? [];
};

const collectRefs = (sessionManager: any, scope: "lineage" | "all"): CollectedRef[] => {
  const refs: CollectedRef[] = [];
  for (const entry of entriesForScope(sessionManager, scope)) {
    if (entry?.type === "custom_message" && entry.customType === PI_VCC_MRC_REFERENCES_TYPE && isJournalDetails(entry.details)) {
      for (const ref of entry.details.refs) {
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

const scoreRef = (ref: CollectedRef, query: string): number => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${ref.id}\n${ref.kind}\n${ref.summary}\n${ref.text}`.toLowerCase();
  return terms.reduce((score, term) => score + (hay.includes(term) ? 1 : 0), 0);
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
    name: "vcc_lookup",
    label: "VCC Lookup",
    description:
      "Lookup exact MRC reference chunks by ref handle, or search/list append-only MRC reference notes. " +
      "Use this when the prompt contains ref:* handles or when you need exact prior MRC chunk bodies without broad transcript search.",
    promptSnippet:
      "vcc_lookup: Lookup exact MRC reference chunks by ref handle, query, or list recent refs.",
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: "Reference handle such as 'ref:evidence:abc123' or 'evidence:abc123'." })),
      query: Type.Optional(Type.String({ description: "Search MRC reference summaries and hidden chunk bodies." })),
      list: Type.Optional(Type.Boolean({ description: "List recent reference handles without expanding full bodies." })),
      limit: Type.Optional(Type.Number({ description: "Maximum results. Default 5 for query/list." })),
      scope: Type.Optional(Type.Union([Type.Literal("lineage"), Type.Literal("all")], { description: "Lookup scope. Default lineage." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope === "all" ? "all" : "lineage";
      const refs = collectRefs(ctx.sessionManager, scope);
      const limit = Math.max(1, Math.min(25, params.limit ?? 5));

      if (params.ref?.trim()) {
        const wanted = normalizeRef(params.ref);
        const matches = refs.filter((ref) => ref.id === wanted || `ref:${ref.id}` === params.ref?.trim());
        const text = matches.length > 0
          ? renderFull(matches)
          : `No MRC reference found for ref:${wanted} in ${scope} scope.`;
        return { content: [{ type: "text", text }], details: { matches } };
      }

      if (params.query?.trim()) {
        const scored = refs
          .map((ref) => ({ ref, score: scoreRef(ref, params.query!.trim()) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score || b.ref.createdAt.localeCompare(a.ref.createdAt))
          .slice(0, limit)
          .map((item) => item.ref);
        const text = scored.length > 0
          ? renderFull(scored)
          : `No MRC references matched ${JSON.stringify(params.query)} in ${scope} scope.`;
        return { content: [{ type: "text", text }], details: { matches: scored } };
      }

      const recent = refs.slice(-limit).reverse();
      const text = recent.length > 0
        ? `Recent MRC refs (${scope}):\n${renderSummary(recent)}`
        : `No MRC references found in ${scope} scope.`;
      return { content: [{ type: "text", text }], details: { matches: recent } };
    },
  });
};
