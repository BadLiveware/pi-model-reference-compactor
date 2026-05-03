/**
 * Model-reference compactor for benchmark harness.
 *
 * Architecture:
 * 1. Extract chunks from built compaction state
 * 2. Classify chunks via mock model → KEEP / REF / DROP + MVS
 * 3. Order KEEP chunks for cache-prefix stability
 * 4. Stitch Tier 1 active prompt: MVS + ordered KEEP sections + recall note
 *
 * Imported and registered in bench/compaction/offline-runner.ts.
 */

import type { Message } from "@mariozechner/pi-ai";
import { normalize } from "../../src/core/normalize";
import { filterNoise } from "../../src/core/filter-noise";
import { buildSections } from "../../src/core/build-sections";
import { buildCompactionState } from "../../src/core/compaction-state";
import { chunkCompactionState, type CompactionChunk } from "../../src/core/chunk-model";
import { mockClassify } from "../../src/core/mock-classifier";
import { realClassify } from "../../src/core/classifier";
import type { CompactorContext, CompactorResult, LayerSnapshot } from "./offline-runner";

/** Rendered chunk as a text line for the final prompt */
const renderKeepChunk = (chunk: CompactionChunk): string => {
  // Prefix with kind for context
  const prefix = chunk.kind === "transcript-line" ? "" : `${chunk.kind}: `;
  return `${prefix}${chunk.text}`;
};

/** Group keep chunks by kind and render as section-like blocks */
const renderKeepSections = (chunks: CompactionChunk[]): string => {
  const byKind = new Map<string, CompactionChunk[]>();
  for (const c of chunks) {
    const group = byKind.get(c.kind) || [];
    group.push(c);
    byKind.set(c.kind, group);
  }

  const sections: string[] = [];

  // Order: goal, scope, decision, file, commit, evidence, preference, transcript, other
  const kindOrder: string[] = [
    "goal", "scope", "recent-scope",
    "file", "commit", "recent-commit",
    "evidence", "recent-evidence",
    "preference", "recent-preference",
    "outstanding-context",
    "transcript-line",
  ];

  for (const kind of kindOrder) {
    const items = byKind.get(kind);
    if (!items || items.length === 0) continue;
    const label = kind.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const body = items.map(renderKeepChunk).join("\n");
    sections.push(`[${label}]\n${body}`);
    byKind.delete(kind);
  }

  // Remaining kinds
  for (const [kind, items] of [...byKind].sort(([a], [b]) => a.localeCompare(b))) {
    const label = kind.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const body = items.map(renderKeepChunk).join("\n");
    sections.push(`[${label}]\n${body}`);
  }

  return sections.join("\n\n");
};

/**
 * Simple stability-aware ordering of KEEP chunks.
 * Within each kind, chunks are sorted to maximize prefix stability:
 * previously-seen chunks (by ID) come first, then new chunks.
 */
const orderKeepChunks = (chunks: CompactionChunk[], previousKeepIds: Set<string>): CompactionChunk[] => {
  return [...chunks].sort((a, b) => {
    // Previously kept chunks come first (stability)
    const aPrev = previousKeepIds.has(a.id) ? 0 : 1;
    const bPrev = previousKeepIds.has(b.id) ? 0 : 1;
    if (aPrev !== bPrev) return aPrev - bPrev;

    // Within stability groups: kind ordering
    const kindOrder: Record<string, number> = {
      goal: 0, scope: 1, "recent-scope": 2,
      file: 3, commit: 4, "recent-commit": 5,
      evidence: 6, "recent-evidence": 7,
      preference: 8, "recent-preference": 9,
      "outstanding-context": 10,
      "transcript-line": 11,
    };
    return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
  });
};

const RECALL_NOTE =
  "Use `vcc_recall` to search for prior work, decisions, and context from before this summary. " +
  "Do not redo work already completed.";

const REF_INDEX_KEY = "model-ref-index";

export const createModelReferenceCompactor = (helpers: {
  sourceTextOf: (messages: Message[]) => string;
  estimateTokens: (text: string) => number;
  renderedDocuments: (messages: Message[]) => Array<{ id: string; text: string; source: string }>;
}) => ({
  name: "model-reference-selector",
  compact: async (ctx: CompactorContext): Promise<CompactorResult> => {
    const { messages, allMessages, previous } = ctx;
    const inputTokens = helpers.estimateTokens(helpers.sourceTextOf(messages));

    // Check env for real classifier config
    const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
    const classifierModel = process.env.CLASSIFIER_MODEL || "deepseek-chat";
    const classifierBaseUrl = process.env.CLASSIFIER_BASE_URL || "https://api.deepseek.com/v1";
    const useRealClassifier = !!(apiKey && classifierModel);

    // 0. Recover previous classification for merge-awareness
    const prevRefIndex = (previous as any)?.refIndex;
    const previousKeepIds = new Set<string>(prevRefIndex?.keepIds ?? []);
    const previousRefIds = new Set<string>(prevRefIndex?.refs?.map((r: any) => r.id) ?? []);

    // 1. Build compaction state (reuse existing pipeline)
    const blocks = filterNoise(normalize(messages));
    const sectionData = buildSections({ blocks });
    const state = buildCompactionState(sectionData);

    // 2. Chunk the state, plus previous KEEP and REF chunks for merge-awareness
    const chunks = chunkCompactionState(state);

    // Merge previous KEEP/REF chunks so the model can re-classify them
    if (prevRefIndex?.keepChunks) {
      for (const c of prevRefIndex.keepChunks as CompactionChunk[]) {
        // Only add if not already present (by stable ID)
        if (!chunks.some((existing) => existing.id === c.id)) {
          chunks.push(c);
        }
      }
    }
    if (prevRefIndex?.refChunks) {
      for (const c of prevRefIndex.refChunks as CompactionChunk[]) {
        if (!chunks.some((existing) => existing.id === c.id)) {
          chunks.push(c);
        }
      }
    }

    // 4. Classify (real API if env vars set, else mock)
    const start = performance.now();
    let classification: any;
    if (useRealClassifier) {
      classification = await realClassify(chunks, messages.length, {
        baseUrl: classifierBaseUrl,
        apiKey,
        model: classifierModel,
        maxTokens: 1024,
      });
    } else {
      classification = mockClassify(chunks, messages.length, {
        previousIds: {
          keepIds: [...previousKeepIds],
          refIds: [...previousRefIds],
        },
      });
    }

    // 5. Build KEEP chunk objects
    const keepChunks = chunks.filter((c) => classification.keepIds.includes(c.id));

    // 6. Order KEEP chunks for stability
    const ordered = orderKeepChunks(keepChunks, previousKeepIds);

    // 7. Render Tier 1 active prompt
    const keepText = renderKeepSections(ordered);
    const tier1 = classification.mvs + "\n\n" + keepText;
    const activePromptState = [tier1, RECALL_NOTE].filter(Boolean).join("\n\n---\n\n");

    const elapsed = performance.now() - start;

    // 8. Build layers for benchmark metrics
    const layers: LayerSnapshot[] = [
      { name: "Model-Ref MVS", role: "current", text: classification.mvs },
      { name: "Model-Ref KEEP Chunks", role: "current", text: keepText },
      { name: "Model-Ref Recall Note", role: "recall", text: RECALL_NOTE },
    ];

    const refDocs = classification.refs.map((r) => ({
      id: r.id,
      text: r.summary,
      source: `model-ref-tier2` as const,
    }));

    return {
      activePromptState,
      layers,
      recallCorpus: helpers.renderedDocuments(allMessages).concat(refDocs),
      stats: {
        compactionMs: elapsed,
        estimatedInputTokens: inputTokens,
        estimatedOutputTokens: helpers.estimateTokens(activePromptState),
      },
      // Store classification metadata for next compaction's stability ordering
      refIndex: {
        keepIds: classification.keepIds,
        refs: classification.refs,
        keepChunks: keepChunks.map((c) => ({ id: c.id, kind: c.kind, text: c.text, section: c.section, index: c.index })),
        refChunks: chunks.filter((c) => classification.refs.some((r) => r.id === c.id)),
      },
    } as any;
  },
});
