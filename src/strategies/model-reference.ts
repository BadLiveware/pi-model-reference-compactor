/**
 * Model-reference compaction strategy for pi-vcc.
 *
 * Hooks into Pi's session_before_compact event. Instead of algorithmic extraction
 * (pi-vcc), this strategy calls a cheap LLM to classify conversation chunks into
 * KEEP/REF/DROP tiers, orders KEEP chunks for cache stability, and stitches a
 * compact Tier 1 active prompt with actionable REF index.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { normalize } from "../core/normalize";
import { filterNoise } from "../core/filter-noise";
import { buildSections } from "../core/build-sections";
import { buildCompactionState } from "../core/compaction-state";
import { chunkCompactionState } from "../core/chunk-model";
import { mockClassify } from "../core/mock-classifier";
import { realClassify } from "../core/classifier";
import { inlineSmallRefs } from "../core/classifier";
import type { PiVccSettings } from "../core/settings";

const RECALL_NOTE =
  "Use `vcc_recall` to search for prior work, decisions, and context from before this summary. " +
  "Do not redo work already completed.";

/**
 * Build the compacted summary using the model-reference approach.
 * Returns the summary text suitable for Pi's compaction entry.
 */
export const compactWithModelReference = async (
  messages: any[],
  settings: PiVccSettings,
): Promise<{ summary: string; stats: { classifierMs: number } }> => {
  const start = performance.now();

  // 1. Build compaction state from messages
  const normalized = normalize(messages);
  const filtered = filterNoise(normalized);
  const sectionData = buildSections({ blocks: filtered });
  const state = buildCompactionState(sectionData);

  // 2. Chunk the state
  const chunks = chunkCompactionState(state);

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

  // 4. Assemble Tier 1 summary
  const parts: string[] = [];
  
  // MVS paragraph
  parts.push(classification.mvs);

  // OVERARCHING
  if (classification.overarching) {
    parts.push(`[Overarching]\n${classification.overarching}`);
  }

  // SUBGOALS
  if (classification.subGoals && classification.subGoals.length > 0) {
    const lines = classification.subGoals.map(
      (sg: any) => `${sg.status}: ${sg.label}`,
    );
    parts.push(`[Sub-goals]\n${lines.join("\n")}`);
  }

  // REF index
  const refLines: string[] = [];
  for (const ref of classification.refs || []) {
    refLines.push(`- ${ref.summary}`);
  }
  for (const bundle of classification.bundles || []) {
    refLines.push(
      `- [${bundle.label}] ${bundle.recallCondition} (${bundle.chunkIds.length} chunks, bundle:${bundle.id})`,
    );
  }
  if (refLines.length > 0) {
    parts.push(`[Retrievable]\n${refLines.slice(0, 10).join("\n")}`);
  }

  // Recall note
  parts.push(RECALL_NOTE);

  const summary = parts.filter(Boolean).join("\n\n");
  const elapsed = performance.now() - start;

  return {
    summary,
    stats: { classifierMs: elapsed },
  };
};
