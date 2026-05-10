import type { Message } from "@mariozechner/pi-ai";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { buildSections } from "./build-sections";
import { buildCompactionState } from "./compaction-state";
import { chunkCompactionState, type CompactionChunk } from "./chunk-model";
import { renderRetrievableIndex } from "./model-reference-stitch";
import type { ChunkClassification } from "./chunk-model";

export const PI_VCC_MRC_REFERENCES_TYPE = "pi-vcc-mrc-references";

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

const shortHash = (text: string): string => {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
};

const refIdOf = (chunk: CompactionChunk): string =>
  `${chunk.kind}:${shortHash(`${chunk.kind}\n${chunk.section}\n${chunk.text}`)}`;

const compactText = (text: string, limit = 120): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3).trimEnd()}...`;
};

const summaryOf = (chunk: CompactionChunk): string => {
  switch (chunk.kind) {
    case "read-context": return `lookup if recent read-file code context is needed: ${compactText(chunk.text, 90)}`;
    case "file": return `lookup if file activity details are needed: ${compactText(chunk.text, 90)}`;
    case "evidence":
    case "recent-evidence": return `lookup if evidence details are needed: ${compactText(chunk.text, 90)}`;
    case "preference":
    case "recent-preference": return `lookup if user preference details are needed: ${compactText(chunk.text, 90)}`;
    case "outstanding-context": return `lookup if blocker/error context is needed: ${compactText(chunk.text, 90)}`;
    case "transcript-line": return `lookup if this turn decision/action is needed: ${compactText(chunk.text, 90)}`;
    default: return `lookup if ${chunk.kind} context is needed: ${compactText(chunk.text, 90)}`;
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
    const id = refIdOf(chunk);
    if (seen.has(id)) continue;
    seen.add(id);
    refs.push({
      id,
      kind: chunk.kind,
      text: chunk.text,
      summary: summaryOf(chunk),
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
  return renderRetrievableIndex(classification).replace(/^\[Retrievable\]/, "[MRC refs]");
};

export const isMrcReferenceMessage = (message: any): boolean =>
  message?.role === "custom" && message?.customType === PI_VCC_MRC_REFERENCES_TYPE;
