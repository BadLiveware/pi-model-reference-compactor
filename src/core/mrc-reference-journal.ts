import type { Message } from "@mariozechner/pi-ai";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { buildSections } from "./build-sections";
import { buildCompactionState } from "./compaction-state";
import { chunkCompactionState, type CompactionChunk } from "./chunk-model";
import { renderRetrievableIndex } from "./model-reference-stitch";
import type { ChunkClassification } from "./chunk-model";

// Hidden, non-context state: full ref bodies live here.
export const PI_MRC_REFERENCES_STATE_TYPE = "pi-mrc-reference-state";

// Context-visible handle-only breadcrumbs near the turn that created hidden refs.
export const PI_MRC_ANCHOR_TYPE = "pi-mrc-anchor";

// Rendered ephemeral latest-compaction ref metadata. This is not persisted.
export const PI_MRC_REFERENCES_TYPE = "pi-mrc-references";

export const MRC_REFERENCE_PROMPT_GUIDELINES = [
  "Treat `ref:*`, `[MRC anchors: ...]`, and `[MRC refs]` as internal pi-mrc continuity metadata, not user-facing content.",
  "Ignore `[MRC anchors: ...]` during normal work unless you need to recover hidden context; they mainly exist so compaction can preserve lookup handles.",
  "Treat `[MRC refs]` as internal latest-compaction lookup metadata, not a user request; prefer visible context, and call `mrc_lookup` only when the needed detail is not visible or exact hidden text is required.",
  "Do not mention, quote, or expose MRC handles to the user unless the user explicitly asks about refs, lookup, or compaction internals.",
  "A ref handle is not evidence by itself; inspect it with `mrc_lookup` before relying on its hidden contents.",
  "For refs that point at repository source, expect a locator rather than source body; reread the file/symbol for authoritative code.",
];

export interface MrcReferenceEntry {
  id: string;
  kind: CompactionChunk["kind"];
  text: string;
  summary: string;
  source: "turn" | "compaction";
  createdAt: string;
}

export interface MrcReferenceJournalDetails {
  version: 1;
  refs: MrcReferenceEntry[];
}

export interface MrcReferenceAnchorDetails {
  version: 1;
  refIds: string[];
  createdAt: string;
}

const DEFAULT_STASH_REF_LIMIT = 100;

const shortHash = (text: string): string => {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
};

const refIdOf = (chunk: CompactionChunk, text = chunk.text): string =>
  `${chunk.kind}:${shortHash(`${chunk.kind}\n${chunk.section}\n${text}`)}`;

const compactText = (text: string, limit = 120): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3).trimEnd()}...`;
};

const SOURCE_PATH_RE = /^([^:\n]+\.[A-Za-z0-9][A-Za-z0-9._-]*):\s*([\s\S]+)$/;
const DECL_SYMBOL_RE = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g;
const CALLISH_SYMBOL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;

const unique = <T>(items: T[]): T[] => [...new Set(items)];

const sourceLocatorOf = (text: string): string | undefined => {
  const match = text.match(SOURCE_PATH_RE);
  if (!match) return undefined;
  const path = match[1].trim();
  const snippet = match[2].trim();
  const symbols = unique([
    ...[...snippet.matchAll(DECL_SYMBOL_RE)].map((m) => m[1]),
    ...[...snippet.matchAll(CALLISH_SYMBOL_RE)]
      .map((m) => m[1])
      .filter((name) => !/^(if|for|while|switch|return|catch|function)$/.test(name)),
  ]).slice(0, 5);
  const symbolText = symbols.length > 0 ? ` symbols: ${symbols.join(", ")};` : "";
  return `Source locator: ${path};${symbolText} reread the repository file for authoritative source.`;
};

const storedTextOf = (chunk: CompactionChunk): string => {
  if (chunk.kind === "read-context") {
    return sourceLocatorOf(chunk.text) ?? chunk.text;
  }
  return chunk.text;
};

const summaryOf = (chunk: CompactionChunk, text = chunk.text): string => {
  switch (chunk.kind) {
    case "read-context": return `lookup if recent read-file locator is needed: ${compactText(text, 90)}`;
    case "file": return `lookup if file activity details are needed: ${compactText(text, 90)}`;
    case "evidence":
    case "recent-evidence": return `lookup if evidence details are needed: ${compactText(text, 90)}`;
    case "preference":
    case "recent-preference": return `lookup if user preference details are needed: ${compactText(text, 90)}`;
    case "outstanding-context": return `lookup if blocker/error context is needed: ${compactText(text, 90)}`;
    case "transcript-line": return `lookup if this turn decision/action is needed: ${compactText(text, 90)}`;
    default: return `lookup if ${chunk.kind} context is needed: ${compactText(text, 90)}`;
  }
};

const scoreChunk = (chunk: CompactionChunk): number => {
  const text = chunk.text;
  switch (chunk.kind) {
    case "read-context": return 8;
    case "evidence":
    case "recent-evidence": return 7;
    case "file": return 6;
    case "outstanding-context": return 6;
    case "preference":
    case "recent-preference": return 5;
    case "scope":
    case "recent-scope": return 4;
    case "transcript-line":
      return /\b(decision|decided|next|patch|fix|implement|rerun|error|failed|request_id|commit|constraint)\b/i.test(text) ? 4 : 0;
    default:
      return /\b([\w./-]+\.[\w]{1,6}|ERR_|request_id=|CACHE_|commit|decision)\b/i.test(text) ? 3 : 0;
  }
};

export const buildMrcReferenceJournal = (
  messages: Message[],
  options: { maxRefs?: number; createdAt?: string } = {},
): MrcReferenceJournalDetails | undefined => {
  const blocks = filterNoise(normalize(messages));
  const state = buildCompactionState(buildSections({ blocks }));
  const chunks = chunkCompactionState(state)
    .map((chunk) => ({ chunk, score: scoreChunk(chunk) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .slice(0, options.maxRefs ?? 8)
    .map((item) => item.chunk);

  if (chunks.length === 0) return undefined;

  const createdAt = options.createdAt ?? new Date().toISOString();
  const seen = new Set<string>();
  const refs: MrcReferenceEntry[] = [];
  for (const chunk of chunks) {
    const text = storedTextOf(chunk);
    const id = refIdOf(chunk, text);
    if (seen.has(id)) continue;
    seen.add(id);
    refs.push({
      id,
      kind: chunk.kind,
      text,
      summary: summaryOf(chunk, text),
      source: "turn",
      createdAt,
    });
  }

  return refs.length > 0 ? { version: 1, refs } : undefined;
};

export const renderMrcReferenceJournalContent = (details: MrcReferenceJournalDetails): string => {
  const classification: ChunkClassification = {
    keepIds: [],
    refs: details.refs.map((ref) => ({ id: ref.id, summary: ref.summary })),
    dropIds: [],
    mvs: "",
  };
  return renderRetrievableIndex(classification)
    .replace(/^\[Retrievable\]/, "[MRC refs]")
    .replace(
      "[MRC refs]\n",
      "[MRC refs]\nmetadata: internal mrc_lookup index, not a user request. purpose: optional exact lookup when visible context is insufficient. source refs: locators only; authoritative code comes from rereading files. user-facing: handles are internal unless the user asks about refs.\n",
    );
};

export const insertBeforeLatestUserMessage = (messages: any[], message: any): any[] => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      return [...messages.slice(0, i), message, ...messages.slice(i)];
    }
  }
  return [...messages, message];
};

export const renderMrcReferenceAnchor = (details: MrcReferenceJournalDetails, limit = 8): string | undefined => {
  const refIds = details.refs.slice(0, limit).map((ref) => `ref:${ref.id}`);
  if (refIds.length === 0) return undefined;
  return `[MRC anchors: ${refIds.join(" ")}]`;
};

export const buildMrcReferenceAnchorDetails = (details: MrcReferenceJournalDetails): MrcReferenceAnchorDetails => ({
  version: 1,
  refIds: details.refs.map((ref) => ref.id),
  createdAt: details.refs[0]?.createdAt ?? new Date().toISOString(),
});

const isJournalDetails = (value: any): value is MrcReferenceJournalDetails =>
  value?.version === 1 && Array.isArray(value.refs);

export const isMrcReferenceMessage = (message: any): boolean =>
  message?.role === "custom" && message?.customType === PI_MRC_REFERENCES_TYPE;

export const isMrcAnchorMessage = (message: any): boolean =>
  message?.role === "custom" && message?.customType === PI_MRC_ANCHOR_TYPE;

const refsFromCompactionDetails = (entry: any): MrcReferenceEntry[] => {
  const refs = entry?.details?.modelReferenceIndex?.refs;
  return Array.isArray(refs) ? refs.filter((ref: any) => ref?.id && ref?.text) : [];
};

export const refsFromLatestCompaction = (entries: any[], limit = DEFAULT_STASH_REF_LIMIT): MrcReferenceEntry[] => {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type !== "compaction") continue;
    const refs = refsFromCompactionDetails(entries[i]);
    return latestUniqueRefs(refs, limit);
  }
  return [];
};

export const refsFromMrcReferenceEntries = (entries: any[]): MrcReferenceEntry[] => {
  const refs: MrcReferenceEntry[] = [];
  for (const entry of entries) {
    if (entry?.type === "custom" && entry.customType === PI_MRC_REFERENCES_STATE_TYPE && isJournalDetails(entry.data)) {
      refs.push(...entry.data.refs.filter((ref: any) => ref?.id && ref?.text));
    }
  }
  return refs;
};

export const latestUniqueRefs = (refs: MrcReferenceEntry[], limit = 8): MrcReferenceEntry[] => {
  const seen = new Set<string>();
  const out: MrcReferenceEntry[] = [];
  for (let i = refs.length - 1; i >= 0 && out.length < limit; i--) {
    const ref = refs[i];
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out.reverse();
};

const markAsCompactionRefs = (refs: MrcReferenceEntry[], createdAt = new Date().toISOString()): MrcReferenceEntry[] =>
  refs.map((ref) => ({ ...ref, source: "compaction", createdAt }));

export const buildCompactionMrcReferenceIndex = (
  branchEntries: any[],
  firstKeptEntryId: string,
  limit = DEFAULT_STASH_REF_LIMIT,
): MrcReferenceJournalDetails | undefined => {
  const lastCompactionIdx = (() => {
    for (let i = branchEntries.length - 1; i >= 0; i--) {
      if (branchEntries[i]?.type === "compaction") return i;
    }
    return -1;
  })();

  const firstKeptIdx = firstKeptEntryId
    ? branchEntries.findIndex((entry) => entry?.id === firstKeptEntryId)
    : branchEntries.length;
  const cutEndIdx = firstKeptIdx >= 0 ? firstKeptIdx : branchEntries.length;
  const newStashEntries = branchEntries.slice(Math.max(0, lastCompactionIdx + 1), cutEndIdx);

  const previousStash = refsFromLatestCompaction(branchEntries, limit);
  const newStash = refsFromMrcReferenceEntries(newStashEntries);
  const refs = latestUniqueRefs(markAsCompactionRefs([...previousStash, ...newStash]), limit);
  return refs.length > 0 ? { version: 1, refs } : undefined;
};

const textFromMessageContent = (content: any): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part?.type === "text") return part.text ?? "";
    if (part?.type === "toolResult") return typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
    return "";
  }).join("\n");
};

const normalizeVisibleText = (text: string): string => text.replace(/\s+/g, " ").trim();

const visibleTextFromMessages = (messages: any[] = []): string =>
  normalizeVisibleText(messages.map((message) => textFromMessageContent(message?.content)).join("\n"));

const refTextAlreadyVisible = (ref: MrcReferenceEntry, visibleText: string): boolean => {
  const needle = normalizeVisibleText(ref.text);
  return needle.length >= 8 && visibleText.includes(needle);
};

export const renderEphemeralMrcRefs = (
  entries: any[],
  limit = 8,
  visibleMessages: any[] = [],
): string | undefined => {
  const visibleText = visibleTextFromMessages(visibleMessages);
  const refs = refsFromLatestCompaction(entries, DEFAULT_STASH_REF_LIMIT)
    .filter((ref) => !refTextAlreadyVisible(ref, visibleText));
  const selected = latestUniqueRefs(refs, limit);
  if (selected.length === 0) return undefined;
  return renderMrcReferenceJournalContent({ version: 1, refs: selected });
};
