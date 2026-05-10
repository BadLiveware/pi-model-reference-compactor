import type { ChunkClassification, CompactionChunk } from "./chunk-model";

export const MODEL_REFERENCE_RECALL_NOTE = [
  "MRC reference handling:",
  "- `ref:*` handles are internal continuity breadcrumbs, not user-facing output.",
  "- `[MRC anchors: ...]` near prior turns exist so future compactions can preserve lookup continuity; ignore them during normal work unless you need hidden context.",
  "- `[MRC refs]` at the end of context lists refs stashed by the latest compaction; use `mrc_lookup` only when needed detail is not visible inline.",
  "- Do not mention, quote, or expose handles to the user unless the user explicitly asks about refs, lookup, or compaction internals.",
  "- A handle is not evidence by itself; inspect it with `mrc_lookup` before relying on hidden contents.",
  "- Source refs are locators, not authoritative code bodies; reread repository files/symbols for current source.",
  "Use exact lookup for handles only; broad/fuzzy transcript search is outside MRC. Do not redo work already completed.",
].join("\n");

const KIND_ORDER: Record<string, number> = {
  goal: 0,
  scope: 1,
  "recent-scope": 2,
  file: 3,
  "read-context": 4,
  commit: 5,
  "recent-commit": 6,
  evidence: 7,
  "recent-evidence": 8,
  preference: 9,
  "recent-preference": 10,
  "outstanding-context": 11,
  "transcript-line": 12,
  recall: 13,
};

const titleOfKind = (kind: string): string =>
  kind.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const KNOWN_KINDS = new Set<CompactionChunk["kind"]>([
  "goal",
  "scope",
  "recent-scope",
  "file",
  "read-context",
  "commit",
  "recent-commit",
  "evidence",
  "recent-evidence",
  "preference",
  "recent-preference",
  "outstanding-context",
  "transcript-line",
  "recall",
]);

const kindFromSection = (section: string): CompactionChunk["kind"] => {
  switch (section) {
    case "sessionGoal": return "goal";
    case "currentScope": return "scope";
    case "recentScope": return "recent-scope";
    case "files": return "file";
    case "readContext": return "read-context";
    case "commits": return "commit";
    case "recentCommits": return "recent-commit";
    case "evidence": return "evidence";
    case "recentEvidence": return "recent-evidence";
    case "preferences": return "preference";
    case "recentPreferences": return "recent-preference";
    case "outstanding": return "outstanding-context";
    case "transcript": return "transcript-line";
    default: return "transcript-line";
  }
};

const shortHash = (text: string): string => {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 6);
};

const collisionAliasOf = (chunk: CompactionChunk): string =>
  `previous-${chunk.section}-${shortHash(chunk.text)}:${chunk.index}`;

const renderKeepChunk = (chunk: CompactionChunk): string => {
  const prefix = chunk.kind === "transcript-line" ? "" : `${chunk.kind}: `;
  return `- ${chunk.id} — ${prefix}${chunk.text}`;
};

export const orderKeepChunks = (
  chunks: CompactionChunk[],
  previousKeepIds: Set<string> = new Set(),
): CompactionChunk[] =>
  [...chunks].sort((a, b) => {
    const aPrev = previousKeepIds.has(a.id) ? 0 : 1;
    const bPrev = previousKeepIds.has(b.id) ? 0 : 1;
    if (aPrev !== bPrev) return aPrev - bPrev;

    const kindDelta = (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99);
    if (kindDelta !== 0) return kindDelta;

    return a.id.localeCompare(b.id);
  });

export const renderKeepSections = (chunks: CompactionChunk[]): string => {
  const byKind = new Map<string, CompactionChunk[]>();
  for (const chunk of chunks) {
    const group = byKind.get(chunk.kind) ?? [];
    group.push(chunk);
    byKind.set(chunk.kind, group);
  }

  const sections: string[] = [];
  const kinds = [...byKind.keys()].sort((a, b) => (KIND_ORDER[a] ?? 99) - (KIND_ORDER[b] ?? 99) || a.localeCompare(b));
  for (const kind of kinds) {
    const items = byKind.get(kind) ?? [];
    if (items.length === 0) continue;
    sections.push(`[${titleOfKind(kind)}]\n${items.map(renderKeepChunk).join("\n")}`);
  }
  return sections.join("\n\n");
};

const renderSubGoals = (classification: ChunkClassification): string => {
  if (!classification.subGoals || classification.subGoals.length === 0) return "";
  const lines = classification.subGoals.map(
    (subGoal) => `${subGoal.status}: ${subGoal.label} (${subGoal.recallCondition} → ${subGoal.ref})`,
  );
  return `[Sub-goals]\n${lines.join("\n")}`;
};

export const renderRetrievableIndex = (classification: ChunkClassification): string => {
  const lines: string[] = [];
  for (const ref of classification.refs ?? []) {
    lines.push(`- ref:${ref.id} — ${ref.summary}`);
  }
  for (const bundle of classification.bundles ?? []) {
    const chunkList = bundle.chunkIds.slice(0, 8).join(", ");
    const suffix = bundle.chunkIds.length > 8 ? `, +${bundle.chunkIds.length - 8} more` : "";
    lines.push(
      `- bundle:${bundle.id} — [${bundle.label}] ${bundle.recallCondition} (${bundle.chunkIds.length} chunks: ${chunkList}${suffix})`,
    );
  }
  return lines.length > 0 ? `[Retrievable]\n${lines.slice(0, 12).join("\n")}` : "";
};

export const extractKeepIdsFromSummary = (summary = ""): Set<string> => {
  const ids = new Set<string>();
  for (const match of summary.matchAll(/^-\s+([A-Za-z][A-Za-z0-9-]*:\d+)\s+—/gm)) {
    ids.add(match[1]);
  }
  return ids;
};

export const extractKeepChunksFromSummary = (summary = ""): CompactionChunk[] => {
  const chunks: CompactionChunk[] = [];
  for (const match of summary.matchAll(/^-\s+([A-Za-z][A-Za-z0-9-]*:\d+)\s+—\s+(.+)$/gm)) {
    const id = match[1];
    let text = match[2].trim();
    const section = id.slice(0, id.lastIndexOf(":"));
    const index = Number.parseInt(id.slice(id.lastIndexOf(":") + 1), 10) || 0;
    let kind = kindFromSection(section);
    const prefix = text.match(/^([a-z][a-z-]+):\s+(.+)$/);
    if (prefix && KNOWN_KINDS.has(prefix[1] as CompactionChunk["kind"])) {
      kind = prefix[1] as CompactionChunk["kind"];
      text = prefix[2];
    }
    chunks.push({ id, kind, text, section, index });
  }
  return chunks;
};

export const mergePriorChunks = (
  currentChunks: CompactionChunk[],
  priorChunks: CompactionChunk[],
): CompactionChunk[] => {
  const merged = [...currentChunks];
  const hasIdAndText = (chunk: CompactionChunk): boolean =>
    merged.some((existing) => existing.id === chunk.id && existing.text === chunk.text);
  const idExists = (id: string): boolean => merged.some((existing) => existing.id === id);

  const hasPreferenceCorrection = currentChunks.some(
    (chunk) =>
      (chunk.kind === "preference" || chunk.kind === "recent-preference" || chunk.kind === "transcript-line") &&
      /\b(correction|never use|do not use|don't use)\b/i.test(chunk.text),
  );

  for (const chunk of priorChunks) {
    if (
      hasPreferenceCorrection &&
      (
        chunk.kind === "preference" ||
        chunk.kind === "recent-preference" ||
        /\b(prefer|always use|please use)\b/i.test(chunk.text)
      )
    ) continue;
    if (hasIdAndText(chunk)) continue;
    const next = idExists(chunk.id)
      ? { ...chunk, id: collisionAliasOf(chunk), section: `previous-${chunk.section}` }
      : chunk;
    if (!hasIdAndText(next) && !idExists(next.id)) merged.push(next);
  }
  return merged;
};

export const renderModelReferenceSummary = (
  classification: ChunkClassification,
  chunks: CompactionChunk[],
  options: { previousKeepIds?: Set<string>; includeRecallNote?: boolean; includeRetrievable?: boolean } = {},
): string => {
  const bundledIds = new Set(classification.bundles?.flatMap((bundle) => bundle.chunkIds) ?? []);
  const keepIds = new Set(classification.keepIds);
  const keepChunks = chunks.filter((chunk) => keepIds.has(chunk.id) && !bundledIds.has(chunk.id));
  const orderedKeep = orderKeepChunks(keepChunks, options.previousKeepIds ?? new Set());

  const parts = [
    classification.mvs,
    classification.overarching ? `[Overarching]\n${classification.overarching}` : "",
    renderSubGoals(classification),
    renderKeepSections(orderedKeep),
    options.includeRetrievable ? renderRetrievableIndex(classification) : "",
  ].filter(Boolean);

  if (options.includeRecallNote !== false) {
    parts.push(MODEL_REFERENCE_RECALL_NOTE);
  }

  return parts.join("\n\n");
};
