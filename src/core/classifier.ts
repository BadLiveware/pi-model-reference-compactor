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

const CLASSIFIER_SYSTEM_PROMPT = `You are a context compaction classifier. Your job is to classify conversation chunks into three tiers so a future LLM can continue the work efficiently.

DO NOT rewrite or summarize the chunk content. You only:
1. Decide which chunks to KEEP, REF, or DROP
2. Write a one-line summary for each REF chunk
3. Write a short Minimum Viable Summary (MVS) paragraph

Classification rules:
- KEEP: Critical for continuing the work. File paths, commit hashes, error signatures, key decisions, active goals, constraints, identifiers needed for tool calls.
- REF: Useful context but not critical. One-line summary so it can be retrieved later if needed. Example: "discussed auth token refresh pattern"
- DROP: Conversational fluff, status updates, repeated content, lunch discussions, greetings.

Output format (strict):
---
KEEP: id1, id2, id3
REF: id4 | discussed auth token refresh
REF: id5 | looked at benchmark results
DROP: id6, id7, id8
MVS: Working on PR #14 for feat/broad-sweep. Added native range auto-chunking instrumentation. Next: clean PR artifacts before merge.
---

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

  if (keepIds.length === 0 && refs.length === 0) return undefined;

  return { keepIds, refs, dropIds, mvs };
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
