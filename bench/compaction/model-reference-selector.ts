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
import { inlineSmallRefs } from "../../src/core/classifier";
import {
  MODEL_REFERENCE_RECALL_NOTE,
  mergePriorChunks,
  orderKeepChunks,
  renderKeepSections,
  renderModelReferenceSummary,
} from "../../src/core/model-reference-stitch";
import type { CompactorContext, CompactorResult, LayerSnapshot } from "./offline-runner";

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
    const classifierModel = process.env.CLASSIFIER_MODEL || "deepseek-chat";
    const classifierBaseUrl = process.env.CLASSIFIER_BASE_URL || "https://api.deepseek.com/v1";
    let apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      try {
        const auth = JSON.parse(require("fs").readFileSync(
          require("path").join(require("os").homedir(), ".pi", "agent", "auth.json"), "utf-8"));
        apiKey = auth?.deepseek?.key || auth?.deepseek?.apiKey;
      } catch {}
    }
    const useRealClassifier = !!(apiKey && classifierModel);

    // 0. Recover previous classification for merge-awareness
    const prevRefIndex = (previous as any)?.refIndex;
    const previousKeepIds = new Set<string>(prevRefIndex?.keepIds ?? []);
    const previousRefIds = new Set<string>(prevRefIndex?.refs?.map((r: any) => r.id) ?? []);

    // 1. Build compaction state (reuse existing pipeline)
    const blocks = filterNoise(normalize(messages));
    const sectionData = buildSections({ blocks });
    const state = buildCompactionState(sectionData);

    // 2. Chunk the state, plus previous KEEP and REF chunks for merge-awareness.
    // Previous chunks can share section-index IDs with fresh chunks; alias those
    // collisions so still-relevant old goals/constraints remain classifiable.
    const chunks = mergePriorChunks(
      chunkCompactionState(state),
      [
        ...((prevRefIndex?.keepChunks as CompactionChunk[] | undefined) ?? []),
        ...((prevRefIndex?.refChunks as CompactionChunk[] | undefined) ?? []),
      ],
    );

    // 4. Classify (real API if env vars set, else mock)
    const start = performance.now();
    let classification: any;
    let realTokenUsage: { promptTokens: number; completionTokens: number } | undefined;
    if (useRealClassifier) {
      const realResult = await realClassify(chunks, messages.length, {
        baseUrl: classifierBaseUrl,
        apiKey,
        model: classifierModel,
        maxTokens: 1024,
      });
      classification = realResult;
      // Auto-promote tiny REFs to KEEP
      classification = inlineSmallRefs(classification, chunks);
      // Store real token usage
      realTokenUsage = realResult.usage;
    } else {
      classification = mockClassify(chunks, messages.length, {
        previousIds: {
          keepIds: [...previousKeepIds],
          refIds: [...previousRefIds],
        },
      });
    }

    // 5. Build KEEP chunk objects (exclude bundled chunks)
    const bundledIds = new Set(classification.bundles?.flatMap((b) => b.chunkIds) ?? []);
    const keepChunks = chunks.filter(
      (c) => classification.keepIds.includes(c.id) && !bundledIds.has(c.id),
    );

    // 6. Order KEEP chunks for stability
    const ordered = orderKeepChunks(keepChunks, previousKeepIds);

    // 7. Render Tier 1 active prompt
    const keepText = renderKeepSections(ordered);
    const activePromptState = renderModelReferenceSummary(classification, chunks, {
      previousKeepIds,
    });

    const elapsed = performance.now() - start;

    // 8. Build layers for benchmark metrics
    const layers: LayerSnapshot[] = [
      { name: "Model-Ref MVS", role: "current", text: classification.mvs },
      { name: "Model-Ref KEEP Chunks", role: "current", text: keepText },
      { name: "Model-Ref Recall Note", role: "recall", text: MODEL_REFERENCE_RECALL_NOTE },
    ];

    const refDocs = [
      ...classification.refs.map((r) => ({
        id: r.id,
        text: `${r.summary} (use vcc_recall)`,
        source: `model-ref-tier2` as const,
      })),
      ...(classification.bundles ?? []).map((b) => ({
        id: `bundle:${b.id}`,
        text: `[${b.label}] ${b.recallCondition}. Files: ${b.chunkIds.filter((id) => id.startsWith("F")).length}, Chunks: ${b.chunkIds.length} (use vcc_recall with bundle:${b.id})`,
        source: `model-ref-bundle` as const,
      })),
    ];

    return {
      activePromptState,
      layers,
      recallCorpus: helpers.renderedDocuments(allMessages).concat(refDocs),
      stats: {
        compactionMs: elapsed,
        estimatedInputTokens: inputTokens,
        estimatedOutputTokens: helpers.estimateTokens(activePromptState),
        // Real API token counts when available
        classifierPromptTokens: realTokenUsage?.promptTokens,
        classifierCompletionTokens: realTokenUsage?.completionTokens,
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
