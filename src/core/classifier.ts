/**
 * Real LLM classifier using an OpenAI-compatible chat API.
 *
 * Sends conversation chunks to a cheap model (default DeepSeek Flash) which
 * classifies them into KEEP (critical, keep in active prompt), REF (useful,
 * store in retrievable index), or DROP (archive only). The model also writes
 * a short Minimum Viable Summary paragraph.
 *
 * The model's job is classification, not content creation. Chunk text is
 * preserved verbatim; the model only picks which to keep and writes one-line
 * summaries for REF chunks and the MVS paragraph.
 */

import type { CompactionChunk, ChunkClassification } from "./chunk-model";

export interface ClassifierConfig {
  /** API base URL (OpenAI-compatible) */
  baseUrl: string;
  /** API key */
  apiKey: string;
  /** Model name (e.g. "deepseek-chat", "gpt-4o-mini") */
  model: string;
  /** Maximum output tokens */
  maxTokens?: number;
  /** Timeout in ms */
  timeoutMs?: number;
}

const CLASSIFIER_SYSTEM_PROMPT = `You are a context compaction classifier. Your job is to classify conversation chunks into tiers so a future LLM can continue the work efficiently.

DO NOT rewrite or summarize the chunk content. You only:
1. Decide which chunks to KEEP, REF, or DROP
2. Write actionable REF summaries with recall conditions
3. Group parked old-goal chunks into BUNDLE entries
4. Write a short Minimum Viable Summary (MVS) paragraph

Classification rules:
- KEEP: ONLY the 15-20 most critical chunks for continuing the CURRENT work. You MUST stay under 20 KEEP chunks total. If in doubt, put it in REF.
  Priority order: 1) user's most recent explicit decisions ("Alright, lets do it" about a topic IS the current goal), 2) active files being edited, 3) current goal statement, 4) key constraints actively in force.
  Do NOT keep: old goals from previous phases, review process meta-guidelines, generic evidence without specific identifiers, repeated goal variants.
- REF: Context that is useful but not critical now. Write "Recall if <trigger condition>" so the agent knows WHEN to retrieve this. Put excess KEEP-qualifying chunks here if over budget.
  Example: "Recall if user asks about MV/RMV (Materialized View/Refreshing Materialized View) tradeoffs" or "Recall if returning to workload-virtual-rule-optimizations".
- DROP: Conversational fluff, status updates, repeated content, lunch discussions, greetings, stale metadata that the agent would never need to recover.

BUDGET ENFORCEMENT: After classification, count your KEEP chunks. If > 20, move the lowest-priority ones to REF.

BUNDLE format (for parked old goals):
- When chunks belong to a previous goal that is no longer active, group them into a named bundle.
- Format: BUNDLE: <id> | <label> | <trigger-condition> | <chunk-ids>
- Example: BUNDLE: broad-sweep | PR #14 range query work | user asks about range query performance | F5,F6,F7,C3
- Note: the trigger-condition should NOT include "Recall if" — just the raw condition text.

Acronym expansion:
- In MVS and REF summaries, expand domain acronyms on first occurrence: RMV → "RMV (Refreshing Materialized View)", MV → "MV (Materialized View)", PR → just "PR".
- Do NOT rewrite chunk text — only expand in the summaries YOU write.

Output format (strict, KEEP capped at 20):
---
KEEP: id1, id2, id3
REF: id4 | Recall if user asks about auth token refresh
REF: id5 | Recall if returning to benchmark framework design
BUNDLE: join-enrichment | Phase 3 join shapes | returning to workload-virtual-rule-optimizations | G2,D13,D14,F7,F8
DROP: id6, id7, id8
MVS: Working on recording rule MV (Materialized View) optimization. User decided to proceed with MV approach after discussing tradeoffs vs live queries. Part of broader PR #14.
---

BUNDLE is optional — only use it when you can clearly group chunks that belong to a named previous goal.
Count your KEEP chunks. If > 20, fix it before outputting.

WRONG (too many KEEP, passive REF, no bundles):
KEEP: id1, id2, id3, id4, id5, id6, id7, id8, id9, id10, id11, id12, id13, id14, id15, id16, id17, id18, id19, id20, id21, id22, id23, id24
REF: id25 | candidate decision pattern
REF: id26 | physical decision in output

RIGHT (capped KEEP, actionable REF, optional bundle):
KEEP: G0, G1, D6, D7, D8, D9, D10, F12, F15, F18, C3, C5
REF: D15 | Recall if user asks about physical decision structure details
REF: F25 | Recall if returning to project structure files
BUNDLE: broad-sweep | PR #14 range query work | user asks about range query performance | F5,F6,F7,C2,C4
DROP: P22, P23, P24, P25
MVS: Working on recording rule MV (Materialized View) optimization for PR #14.

Only output the classification block. No other text.`;

/**
 * Build the user prompt presenting chunks to the model.
 */
const buildChunkPrompt = (chunks: CompactionChunk[]): string => {
  const lines: string[] = [];
  lines.push("Classify these conversation chunks:\n");
  for (const chunk of chunks) {
    const prefix = chunk.kind.toUpperCase();
    const text = chunk.text.substring(0, 300).replace(/\n/g, " ");
    lines.push(`${chunk.id} [${prefix}] ${text}`);
  }
  return lines.join("\n");
};

/**
 * Parse the model's classification output.
 */
const parseClassification = (
  output: string,
): ChunkClassification | undefined => {
  const keepIds: string[] = [];
  const refs: Array<{ id: string; summary: string }> = [];
  const dropIds: string[] = [];
  const bundles: Array<{ id: string; label: string; recallCondition: string; chunkIds: string[] }> = [];
  let mvs = "Continuing work from conversation.";

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const keepMatch = trimmed.match(/^KEEP:\s*(.+)/i);
    if (keepMatch) {
      keepIds.push(
        ...keepMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      continue;
    }

    const refMatch = trimmed.match(/^REF:\s*(\S+)\s*\|\s*(.+)/i);
    if (refMatch) {
      refs.push({ id: refMatch[1].trim(), summary: refMatch[2].trim() });
      continue;
    }

    const bundleMatch = trimmed.match(
      /^BUNDLE:\s*(\S+)\s*\|\s*([^|]+)\s*\|\s*([^|]+?)\s*\|\s*(.+)/i,
    );
    if (bundleMatch) {
      bundles.push({
        id: bundleMatch[1].trim(),
        label: bundleMatch[2].trim(),
        recallCondition: bundleMatch[3].trim(),
        chunkIds: bundleMatch[4]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      continue;
    }

    const dropMatch = trimmed.match(/^DROP:\s*(.+)/i);
    if (dropMatch) {
      dropIds.push(
        ...dropMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      continue;
    }

    const mvsMatch = trimmed.match(/^MVS:\s*(.+)/i);
    if (mvsMatch) {
      mvs = mvsMatch[1].trim();
      continue;
    }
  }

  if (keepIds.length === 0 && refs.length === 0 && bundles.length === 0) {
    return undefined;
  }

  return { keepIds, refs, dropIds, mvs, bundles };
};

/**
 * Classify chunks using an OpenAI-compatible chat API.
 */
export const realClassify = async (
  chunks: CompactionChunk[],
  messageCount: number,
  config: ClassifierConfig,
): Promise<ChunkClassification> => {
  const { baseUrl, apiKey, model, maxTokens = 1024, timeoutMs = 30000 } = config;

  const userPrompt = buildChunkPrompt(chunks);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Classifier API error ${response.status}: ${text.substring(0, 200)}`,
      );
    }

    const data = (await response.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Classifier returned empty response");
    }

    const result = parseClassification(content);
    if (!result) {
      throw new Error(
        `Failed to parse classifier output: ${content.substring(0, 200)}`,
      );
    }

    return result;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Classify chunks using real API with fallback to mock classifier.
 */
export const classifyWithFallback = async (
  chunks: CompactionChunk[],
  messageCount: number,
  config?: Partial<ClassifierConfig>,
): Promise<ChunkClassification & { usedMock: boolean }> => {
  if (config?.apiKey && config?.baseUrl) {
    try {
      const fullConfig: ClassifierConfig = {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model || "deepseek-chat",
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
      };
      const result = await realClassify(chunks, messageCount, fullConfig);
      return { ...result, usedMock: false };
    } catch (err) {
      console.error(
        `Classifier API call failed, falling back to mock: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Fallback to mock
  const { mockClassify } = await import("./mock-classifier");
  const mockResult = mockClassify(chunks, messageCount);
  return { ...mockResult, usedMock: true };
};
