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

export interface ClassifierResult extends ChunkClassification {
  /** Real token usage from API response */
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

const CLASSIFIER_SYSTEM_PROMPT = `You are a context compaction classifier. Your job is to classify conversation chunks into tiers so a future LLM can continue the work efficiently.

DO NOT rewrite or summarize the chunk content. You only:
1. Decide which chunks to KEEP, REF, or DROP
2. Write actionable REF summaries with recall conditions
3. Group parked old-goal chunks into BUNDLE entries
4. Write a short Minimum Viable Summary (MVS) paragraph

Classification rules:

DECISION PRINCIPLE: For each chunk, ask "Would a new agent need this to make its NEXT tool call or file edit?" If yes → KEEP. If it might help later but not now → REF. If no agent would ever need it → DROP.

SOURCE RECOVERABILITY RULE: Repository source files are cheap, authoritative, and rereadable.
- Do NOT KEEP or REF full source snippets, function bodies, type bodies, or config bodies when a path/symbol/line hint lets the agent reread the source.
- For source-derived context, preserve only minimal locators: file path, symbol/function/class/type name, optional line hint, and why it matters.
- DROP source body details that are easy to recover with read/rg/code-intel.
- KEEP source-derived details only when they are not easily recoverable: uncommitted/deleted edits not present in files, generated/transient output, exact errors, benchmark results, user decisions, constraints, or non-obvious investigation conclusions.
- Prefer conversation-only state over source-visible state.

- KEEP: ONLY what is directly actionable for the IMMEDIATE next step. A new agent reading only KEEP chunks should know: 1) what to work on, 2) which files to touch, 3) what constraints are active, 4) what was just decided. If you can't explain why a chunk would directly affect the next read/edit/bash call, put it in REF.
  Priority: user's last explicit decision > currently edited files > active constraints > current goal > recent evidence. Do NOT keep: old-phase goals, review meta-guidelines, generic evidence without identifiers, repeated goal variants, rereadable source bodies.

- REF: Context an agent might need if the conversation returns to a topic. Write "Recall if <trigger condition>" so the agent knows WHEN to retrieve this.
  INLINING RULE: If the chunk content is shorter than ~120 chars — shorter than or close to the recall condition you would write — just KEEP it instead. Don't make the agent recall something it could just read.
  RECOVERABLE SOURCE RULE: if the full content is in a repository file, the REF summary should be a locator/trigger (path + symbol + why), not a paraphrase of the source body.

- DROP: Fluff, status updates, duplicates, greetings, stale metadata, and source-visible details that can be reread from a path/symbol locator.

KEEP BUDGET: Target ~800-1,500 characters of KEEP output total (roughly 15-25 chunks depending on size). If you exceed the character budget, move lowest-priority items to REF. Prefer keeping 10 high-signal chunks over 25 low-signal ones.

BUNDLE format (for parked old goals):
- When chunks belong to a previous goal that is no longer active, group them into a named bundle.
- Format: BUNDLE: <id> | <label> | <trigger-condition> | <chunk-ids>
- Example: BUNDLE: broad-sweep | PR #14 range query work | user asks about range query performance | F5,F6,F7,C3
- Note: the trigger-condition should NOT include "Recall if" — just the raw condition text.

Acronym expansion:
- In MVS and REF summaries, expand domain acronyms on first occurrence: RMV → "RMV (Refreshing Materialized View)", MV → "MV (Materialized View)", PR → just "PR".
- Do NOT rewrite chunk text — only expand in the summaries YOU write.

Output format (strict, KEEP budget ~800-1500 chars):
---
OVERARCHING: PR #14 feat/broad-sweep — native range chunking, benchmarking, recording rule optimization
KEEP: id1, id2, id3
REF: id4 | Recall if user asks about auth token refresh
BUNDLE: join-enrichment | Phase 3 join shapes | returning to workload-virtual-rule-optimizations | G2,D13,D14,F7,F8
DROP: id6, id7, id8
MVS: Working on recording rule MV (Materialized View) optimization. User decided to proceed with MV approach after discussing tradeoffs vs live queries. Part of broader PR #14.
---

OVERARCHING is the session's persistent big-picture goal — the project or PR that spans all sub-tasks. It rarely changes. One line, no IDs.
MVS is the immediate focus — what the agent should work on NEXT. It changes as sub-tasks shift.

SUBGOALS (replaces flat goal chunks in KEEP):
- List the goal hierarchy with status: CURRENT, UPCOMING, DEFERRED, COMPLETED.
- Format: STATUS: label | recall-condition | bundle-or-chunk-ref
- Example:
  SUBGOALS:
  CURRENT: RMV optimization for recording rules | user asks about MV tradeoffs | G1,D6
  UPCOMING: Benchmark profiling docs update | user asks about benchmark results | F12,F15
  DEFERRED: Native range chunking | user asks about range query performance | bundle:broad-sweep
  COMPLETED: Join enrichment shapes | workload-virtual-rule-optimizations | bundle:workload
- Each sub-goal includes a recall condition so the agent knows when to context-switch.
- CURRENT must have an entry. UPCOMING/DEFERRED/COMPLETED are optional.
BUNDLE is optional — only for clearly named previous goals.

WRONG (no OVERARCHING, no SUBGOALS, MVS too broad, KEEP uncapped):
MVS: The user is working on various things including PR #14, join shapes, recording rules, and bootstrap stability.
KEEP: id1, id2, id3, id4, id5, id6, id7, id8, id9, id10, id11, id12, ...(30 total)

RIGHT (clear OVERARCHING, SUBGOALS roadmap, specific MVS, capped KEEP, parked bundles):
OVERARCHING: PR #14 feat/broad-sweep — native range chunking, benchmarking, recording rule optimization for promshim-ch
SUBGOALS:
CURRENT: RMV optimization for recording rules | user asks about MV tradeoffs | G1,D6,D7,D8
UPCOMING: Benchmark profiling docs update | user asks about benchmark results | F12,F15
DEFERRED: Native range chunking | user asks about range query performance | bundle:broad-sweep
COMPLETED: Join enrichment shapes | workload-virtual-rule-optimizations | bundle:workload
KEEP: D6, D7, D8, D9, D10, F12, F15, F18, C3, C5
REF: D15 | Recall if user asks about physical decision structure
BUNDLE: broad-sweep | PR #14 range query work | user asks about range query performance | F5,F6,F7,C2,C4
DROP: P22, P23, P24
MVS: Working on RMV (Refreshing Materialized View) optimization. User decided to proceed after discussing tradeoffs.

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
  let overarching: string | undefined;
  const subGoals: Array<{ status: string; label: string; recallCondition: string; ref: string }> = [];
  let inSubgoals = false;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Multi-line SUBGOALS section
    if (trimmed.toUpperCase() === "SUBGOALS:") {
      inSubgoals = true;
      continue;
    }
    if (inSubgoals) {
      const sgMatch = trimmed.match(
        /^(CURRENT|UPCOMING|DEFERRED|COMPLETED):\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)/i,
      );
      if (sgMatch) {
        subGoals.push({
          status: sgMatch[1].toUpperCase(),
          label: sgMatch[2].trim(),
          recallCondition: sgMatch[3].trim(),
          ref: sgMatch[4].trim(),
        });
        continue;
      }
      // Malformed subgoal lines with a valid status should be ignored without
      // ending the section; another valid subgoal may follow.
      if (/^(CURRENT|UPCOMING|DEFERRED|COMPLETED):/i.test(trimmed)) continue;
      // A non-subgoal line ends SUBGOALS; fall through so this same line can
      // still be parsed as KEEP/REF/BUNDLE/DROP/MVS below.
      inSubgoals = false;
    }

    const overarchingMatch = trimmed.match(/^OVERARCHING:\s*(.+)/i);
    if (overarchingMatch) {
      overarching = overarchingMatch[1].trim();
      continue;
    }

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

  if (keepIds.length === 0 && refs.length === 0 && bundles.length === 0 && subGoals.length === 0) {
    return undefined;
  }

  return { keepIds, refs, dropIds, mvs, overarching, subGoals, bundles };
};

/**
 * Post-process classification: auto-promote tiny REF entries to KEEP
 * when the content is shorter than the recall overhead.
 * Different thresholds by kind: goals/decisions get a higher bar (they're more
 * valuable to inline) than conversational transcript lines.
 */
export const inlineSmallRefs = (
  classification: ChunkClassification,
  chunks: CompactionChunk[],
): ChunkClassification => {
  const threshold = (kind: string): number => {
    switch (kind) {
      case "goal": return 200;
      case "preference": return 160;
      case "evidence": return 140;
      case "file": return 120; // file paths are usually short, always inline
      case "read-context": return 180;
      case "transcript-line": return 100;
      default: return 120;
    }
  };

  const promotedIds: string[] = [];
  const keptRefs = classification.refs.filter((ref) => {
    const chunk = chunks.find((c) => c.id === ref.id);
    if (chunk && chunk.text.length <= threshold(chunk.kind)) {
      promotedIds.push(ref.id);
      return false;
    }
    return true;
  });
  return {
    ...classification,
    keepIds: [...classification.keepIds, ...promotedIds],
    refs: keptRefs,
  };
};

/**
 * Classify chunks using an OpenAI-compatible chat API.
 */
export const realClassify = async (
  chunks: CompactionChunk[],
  messageCount: number,
  config: ClassifierConfig,
): Promise<ClassifierResult> => {
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

    const usage = data?.usage;
    const tokenUsage = usage
      ? {
          promptTokens: usage.prompt_tokens || usage.promptTokens || 0,
          completionTokens: usage.completion_tokens || usage.completionTokens || 0,
        }
      : undefined;

    const result = parseClassification(content);
    if (!result) {
      throw new Error(
        `Failed to parse classifier output: ${content.substring(0, 200)}`,
      );
    }

    return { ...result, usage: tokenUsage };
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
