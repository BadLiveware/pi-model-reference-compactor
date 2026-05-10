/**
 * Model-reference compaction strategy for pi-mrc.
 *
 * Hooks into Pi's session_before_compact event. It classifies conversation chunks into
 * KEEP/REF/DROP tiers, orders KEEP chunks for cache stability, and stitches a
 * compact Tier 1 active prompt with actionable REF index.
 */

import { normalize } from "../core/normalize";
import { filterNoise } from "../core/filter-noise";
import { buildSections } from "../core/build-sections";
import { buildCompactionState } from "../core/compaction-state";
import { chunkCompactionState } from "../core/chunk-model";
import { mockClassify } from "../core/mock-classifier";
import { realClassify } from "../core/classifier";
import { inlineSmallRefs } from "../core/classifier";
import {
  extractKeepChunksFromSummary,
  extractKeepIdsFromSummary,
  mergePriorChunks,
  renderModelReferenceSummary,
} from "../core/model-reference-stitch";
import type { PiMrcSettings } from "../core/settings";


/**
 * Build the compacted summary using the model-reference approach.
 * Returns the summary text suitable for Pi's compaction entry.
 */
export const compactWithModelReference = async (
  messages: any[],
  settings: PiMrcSettings,
  options: { previousSummary?: string } = {},
): Promise<{ summary: string; stats: { classifierMs: number } }> => {
  const start = performance.now();

  // 1. Build compaction state from messages
  const normalized = normalize(messages);
  const filtered = filterNoise(normalized);
  const sectionData = buildSections({ blocks: filtered });
  const state = buildCompactionState(sectionData);

  // 2. Chunk the state and carry forward previous KEEP chunks so follow-up
  // compactions do not lose still-relevant active context due to fresh ID reuse.
  const chunks = mergePriorChunks(
    chunkCompactionState(state),
    extractKeepChunksFromSummary(options.previousSummary),
  );

  // 3. Classify: prefer Pi auth, then env var, fall back to mock
  let classification: any;
  const model = process.env.CLASSIFIER_MODEL || "deepseek-chat";
  const baseUrl = process.env.CLASSIFIER_BASE_URL || "https://api.deepseek.com/v1";

  // Try Pi's auth storage first
  let apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    try {
      const { readFileSync } = require("fs");
      const { join } = require("path");
      const { homedir } = require("os");
      const authPath = join(homedir(), ".pi", "agent", "auth.json");
      const auth = JSON.parse(readFileSync(authPath, "utf-8"));
      apiKey = auth?.deepseek?.key || auth?.deepseek?.apiKey;
    } catch {}
  }

  if (apiKey) {
    try {
      classification = await realClassify(chunks, messages.length, {
        baseUrl,
        apiKey,
        model,
        maxTokens: 1024,
      });
      classification = inlineSmallRefs(classification, chunks);
    } catch (err) {
      console.error(
        `MR classifier failed, falling back to mock: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!classification) {
    classification = mockClassify(chunks, messages.length);
  }

  // 4. Assemble Tier 1 summary from ordered KEEP chunks plus addressable REF index.
  const summary = renderModelReferenceSummary(classification, chunks, {
    previousKeepIds: extractKeepIdsFromSummary(options.previousSummary),
  });
  const elapsed = performance.now() - start;

  return {
    summary,
    stats: { classifierMs: elapsed },
  };
};
