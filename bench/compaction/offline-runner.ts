import { performance } from "node:perf_hooks";
import type { Message } from "@mariozechner/pi-ai";
import { compileWithReport } from "../../src/core/summarize";
import { buildSections } from "../../src/core/build-sections";
import { normalize } from "../../src/core/normalize";
import { renderMessage } from "../../src/core/render-entries";
import { clip, textOf } from "../../src/core/content";
import { summarizeToolResultForPrompt } from "../../src/core/tool-result-summary";
import type { PiMrcCompactionReport } from "../../src/core/compaction-report";
import { syntheticCompactionCases, type CompactionBenchmarkCase, type ExpectedTerm } from "./synthetic-cases";
import { createModelReferenceCompactor } from "./model-reference-selector";

export type LayerRole = "static" | "current" | "history" | "recall";

export interface LayerSnapshot {
  name: string;
  role: LayerRole;
  text: string;
}

export interface RecallDocument {
  id: string;
  text: string;
}

export interface PromptLayerSnapshot {
  name: string;
  text: string;
}

export interface PromptSnapshot {
  text: string;
  layers: PromptLayerSnapshot[];
}

export interface CompactorResult {
  activePromptState: string;
  layers: LayerSnapshot[];
  recallCorpus: RecallDocument[];
  report?: PiMrcCompactionReport;
  stats: {
    compactionMs: number;
    estimatedInputTokens?: number;
    estimatedOutputTokens?: number;
  };
}

export interface CompactorContext {
  /** Messages newly summarized in this compaction cycle. */
  messages: Message[];
  /** Full replay prefix available up to this compaction point. */
  allMessages: Message[];
  previous?: CompactorResult;
  cycle: number;
}

export interface OfflineCompactor {
  name: string;
  compact(context: CompactorContext): CompactorResult | Promise<CompactorResult>;
}

export interface TermProbeResult {
  label: string;
  term: string;
  applicable: boolean;
  found: boolean;
}

export interface RecallProbeResult extends TermProbeResult {
  query: string;
  topHitIds: string[];
}

export interface PromptLayerDiff {
  layer: string;
  previousPreview: string;
  currentPreview: string;
  addedLines: string[];
  removedLines: string[];
}

export interface CycleMetrics {
  caseId: string;
  compactor: string;
  cycle: number;
  compactionPoint: number;
  activeChars: number;
  activeTokensEst: number;
  currentChars: number;
  currentTokensEst: number;
  fullPromptChars: number;
  fullPromptTokensEst: number;
  compactionMs: number;
  lcpTokensWithPrevious: number | null;
  lcpTokenRatioWithPrevious: number | null;
  firstChangedLayer: string | null;
  changedLayers: string[];
  fullPromptLcpTokensWithPrevious: number | null;
  fullPromptLcpTokenRatioWithPrevious: number | null;
  firstChangedPromptLayer: string | null;
  changedPromptLayers: string[];
  stablePrefixTokens: number | null;
  activeTermRecall: number | null;
  currentTermRecall: number | null;
  recallTermHitRate: number | null;
  continuationTermRecall: number | null;
  forbiddenLeakCount: number;
  forbiddenCurrentLeakCount: number;
  activeAbsentLeakCount: number;
  missingActiveTerms: string[];
  missingCurrentTerms: string[];
  missingRecallTerms: string[];
  leakedForbiddenTerms: string[];
  leakedForbiddenCurrentTerms: string[];
  leakedActiveAbsentTerms: string[];
  layerSizes: Record<string, number>;
  promptLayerSizes: Record<string, number>;
  promptLayerTokenDeltas: Record<string, number>;
  promptLayerDiffs?: PromptLayerDiff[];
  compactionReport?: PiMrcCompactionReport;
}

export interface BenchmarkRunResult {
  cycles: CycleMetrics[];
  aggregate: Record<string, {
    cycles: number;
    meanActiveTokensEst: number;
    meanCurrentTokensEst: number;
    meanFullPromptTokensEst: number;
    meanCompactionMs: number;
    meanActiveTermRecall: number | null;
    meanCurrentTermRecall: number | null;
    meanRecallTermHitRate: number | null;
    meanContinuationTermRecall: number | null;
    totalForbiddenLeaks: number;
    totalForbiddenCurrentLeaks: number;
    totalActiveAbsentLeaks: number;
    meanLcpTokenRatio: number | null;
    meanFullPromptLcpTokenRatio: number | null;
    meanStablePrefixTokens: number | null;
  }>;
}

const SEPARATOR = "\n\n---\n\n";

const tokenize = (text: string): string[] =>
  text.match(/[\p{L}\p{N}_./:-]+|[^\s]/gu) ?? [];

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const lowerIncludes = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

const lcpTokens = (a: string, b: string): number => {
  const aa = tokenize(a);
  const bb = tokenize(b);
  const limit = Math.min(aa.length, bb.length);
  let i = 0;
  while (i < limit && aa[i] === bb[i]) i += 1;
  return i;
};

const renderedDocuments = (messages: Message[]): RecallDocument[] =>
  messages.map((message, index) => {
    const rendered = renderMessage(message, index, true);
    return {
      id: `${index}:${rendered.role}`,
      text: `#${index} [${rendered.role}] ${rendered.summary}`,
    };
  });

const sourceTextOf = (messages: Message[]): string =>
  renderedDocuments(messages).map((doc) => doc.text).join("\n");

const textForRoles = (result: CompactorResult, roles: LayerRole[]): string => {
  const selected = result.layers.filter((layer) => roles.includes(layer.role));
  if (selected.length === 0) return "";
  return selected.map((layer) => `[${layer.name}]\n${layer.text}`).join("\n\n");
};

const renderPromptLayers = (layers: PromptLayerSnapshot[]): string =>
  layers.map((layer) => `[${layer.name}]\n${layer.text}`).join("\n\n");

const simulatedPromptOf = (result: CompactorResult, sourceMessages: Message[]): PromptSnapshot => {
  const recentTail = renderedDocuments(sourceMessages.slice(-2))
    .map((doc) => doc.text)
    .join("\n");
  const layers: PromptLayerSnapshot[] = [
    {
      name: "Provider Prefix",
      text: [
        "system: You are an expert coding assistant operating inside Pi.",
        "format: preserve compacted state sections and use recall before redoing prior work.",
      ].join("\n"),
    },
    {
      name: "Tool Definitions",
      text: "tools: read, bash, edit, write, mrc_lookup",
    },
    {
      name: "Project Instructions",
      text: "project: follow local guidance, validate before claiming completion, avoid destructive actions.",
    },
    ...result.layers.map((layer) => ({ name: layer.name, text: layer.text })),
    {
      name: "Kept Raw Tail",
      text: recentTail || "- (none)",
    },
  ];
  return { layers, text: renderPromptLayers(layers) };
};

const summarizeChangedPromptLayers = (
  previous: PromptSnapshot | undefined,
  current: PromptSnapshot,
): { firstChangedPromptLayer: string | null; changedPromptLayers: string[]; promptLayerTokenDeltas: Record<string, number> } => {
  if (!previous) return { firstChangedPromptLayer: null, changedPromptLayers: [], promptLayerTokenDeltas: {} };
  const prevByName = new Map(previous.layers.map((layer) => [layer.name, layer.text]));
  const changedPromptLayers = current.layers
    .filter((layer) => prevByName.get(layer.name) !== layer.text)
    .map((layer) => layer.name);
  const promptLayerTokenDeltas = Object.fromEntries(current.layers.map((layer) => {
    const previousTokens = tokenize(prevByName.get(layer.name) ?? "").length;
    const currentTokens = tokenize(layer.text).length;
    return [layer.name, currentTokens - previousTokens];
  }));
  return {
    firstChangedPromptLayer: changedPromptLayers[0] ?? null,
    changedPromptLayers,
    promptLayerTokenDeltas,
  };
};

const linePreview = (text: string, maxChars = 400): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars)}...(truncated)`;

const changedPromptLayerDiffs = (
  previous: PromptSnapshot | undefined,
  current: PromptSnapshot,
  changedLayers: string[],
): PromptLayerDiff[] => {
  if (!previous) return [];
  const prevByName = new Map(previous.layers.map((layer) => [layer.name, layer.text]));
  const currentByName = new Map(current.layers.map((layer) => [layer.name, layer.text]));
  return changedLayers.slice(0, 3).map((layer) => {
    const previousText = prevByName.get(layer) ?? "";
    const currentText = currentByName.get(layer) ?? "";
    const previousLines = previousText.split("\n").map((line) => line.trim()).filter(Boolean);
    const currentLines = currentText.split("\n").map((line) => line.trim()).filter(Boolean);
    const previousSet = new Set(previousLines);
    const currentSet = new Set(currentLines);
    return {
      layer,
      previousPreview: linePreview(previousText),
      currentPreview: linePreview(currentText),
      addedLines: currentLines.filter((line) => !previousSet.has(line)).slice(0, 12),
      removedLines: previousLines.filter((line) => !currentSet.has(line)).slice(0, 12),
    };
  });
};

const termProbe = (terms: ExpectedTerm[] = [], sourceText: string, targetText: string): TermProbeResult[] =>
  terms.map((term) => {
    const applicable = lowerIncludes(sourceText, term.term);
    return {
      label: term.label,
      term: term.term,
      applicable,
      found: applicable && lowerIncludes(targetText, term.term),
    };
  });

const leakProbe = termProbe;

const scoreDocument = (doc: string, query: string): number => {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const hay = doc.toLowerCase();
  return terms.reduce((score, term) => score + (hay.includes(term) ? 1 : 0), 0);
};

const recallProbe = (
  terms: ExpectedTerm[] = [],
  sourceText: string,
  corpus: RecallDocument[],
): RecallProbeResult[] =>
  terms.map((term) => {
    const query = term.query ?? term.term;
    const applicable = lowerIncludes(sourceText, term.term);
    const ranked = corpus
      .map((doc) => ({ doc, score: scoreDocument(doc.text, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const found = applicable && ranked.some((entry) => lowerIncludes(entry.doc.text, term.term));
    return {
      label: term.label,
      term: term.term,
      query,
      applicable,
      found,
      topHitIds: ranked.map((entry) => entry.doc.id),
    };
  });

const ratioOf = (probes: TermProbeResult[]): number | null => {
  const applicable = probes.filter((probe) => probe.applicable);
  if (applicable.length === 0) return null;
  return applicable.filter((probe) => probe.found).length / applicable.length;
};

const summarizeChangedLayers = (
  previous: CompactorResult | undefined,
  current: CompactorResult,
): { firstChangedLayer: string | null; changedLayers: string[] } => {
  if (!previous) return { firstChangedLayer: null, changedLayers: [] };
  const prevByName = new Map(previous.layers.map((layer) => [layer.name, layer.text]));
  const changedLayers = current.layers
    .filter((layer) => prevByName.get(layer.name) !== layer.text)
    .map((layer) => layer.name);
  return {
    firstChangedLayer: changedLayers[0] ?? null,
    changedLayers,
  };
};

const lines = (items: string[]): string =>
  items.length === 0 ? "- (none)" : items.map((item) => `- ${item}`).join("\n");

const stableUnique = (items: string[], limit = 12): string[] =>
  [...new Set(items.map((item) => item.trim()).filter(Boolean))].sort().slice(0, limit);

const regexTerms = (text: string, regex: RegExp, limit = 12): string[] =>
  stableUnique([...text.matchAll(regex)].map((match) => match[0]), limit);

const recentHumanLines = (messages: Message[], maxLines = 10): string[] => {
  const out: string[] = [];
  for (const message of messages.slice(-8)) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textOf(message.content);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/\b(next step|current blocker|blocker update|continue|correction|hard constraint|decision)\b/i.test(trimmed)) {
        out.push(trimmed);
      }
    }
  }
  return out.slice(-maxLines);
};

const bulkyPointers = (messages: Message[]): string[] => {
  const out: string[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "toolResult") return;
    const text = textOf(message.content);
    if (text.length < 500) return;
    const paths = regexTerms(text, /\/(?:tmp|var|home|workspace)\/[\w./-]+/g, 4);
    const signatures = regexTerms(text, /\b[A-Z][A-Z0-9_]{4,}\b(?:\s+request_id=[\w-]+)?/g, 4);
    const details = [...paths, ...signatures].join("; ") || clip(text, 120);
    out.push(`#${index} ${message.toolName}: ${details}`);
  });
  return out;
};

const extractDurableMemory = (messages: Message[]): string[] => {
  const memory: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = textOf(message.content);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/\b(correction|never|always|prefer|use npm test|node --test)\b/i.test(trimmed)) {
        memory.push(trimmed);
      }
    }
  }

  const hasNeverYarn = memory.some((item) => /never use yarn/i.test(item));
  const filtered = hasNeverYarn
    ? memory.filter((item) => !/prefer yarn test/i.test(item))
    : memory;
  return stableUnique(filtered, 10);
};

const makeLayeredCheckpoint = (messages: Message[]): LayerSnapshot[] => {
  const blocks = normalize(messages);
  const data = buildSections({ blocks });
  const source = sourceTextOf(messages);
  const paths = regexTerms(source, /(?:^|[\s"'`])(?:\.?\/?[\w.-]+\/)+[\w.-]+(?:\.[\w.-]+)?/g)
    .map((path) => path.trim().replace(/^["'`\s]+/, ""));
  const identifiers = regexTerms(source, /\b(?:ERR|CACHE|CRITICAL|req|spn|cache|commit)[\w:-]{3,}\b/g, 16);
  const commits = regexTerms(source, /\b[0-9a-f]{7,40}\b/g, 8);

  const stableCheckpoint = [
    "Objective:",
    lines(data.sessionGoal),
    "Hard constraints and decisions:",
    lines(regexTerms(source, /(?:Hard constraint|Decision):[^\n]+/gi, 8)),
    "Active files and artifacts:",
    lines(stableUnique([...data.filesAndChanges, ...paths], 16)),
    "Identifiers and evidence handles:",
    lines(stableUnique([...identifiers, ...commits], 20)),
  ].join("\n");

  const volatileState = [
    "Outstanding context:",
    lines(data.outstandingContext),
    "Recent continuation cues:",
    lines(recentHumanLines(messages)),
  ].join("\n");

  const transcriptLines = data.briefTranscript.split("\n").filter(Boolean).slice(-50).join("\n");
  const rawTail = messages.slice(-2).map((message, offset) => {
    const index = messages.length - 2 + offset;
    const rendered = renderMessage(message, index, true);
    if (message.role === "toolResult") {
      return `#${index} [${rendered.role}] ${summarizeToolResultForPrompt(textOf(message.content))}`;
    }
    return `#${index} [${rendered.role}] ${clip(rendered.summary, 700)}`;
  }).join("\n");

  const recallPointers = bulkyPointers(messages);

  return [
    {
      name: "Layer 0 Static Prefix Contract",
      role: "static",
      text: [
        "Compacted state schema v1.",
        "Keep section names and order stable.",
        "Stable facts appear before volatile facts.",
      ].join("\n"),
    },
    {
      name: "Layer 1 Durable Memory",
      role: "current",
      text: lines(extractDurableMemory(messages)),
    },
    {
      name: "Layer 2A Stable Checkpoint",
      role: "current",
      text: stableCheckpoint,
    },
    {
      name: "Layer 2B Volatile State",
      role: "current",
      text: volatileState,
    },
    {
      name: "Layer 3 Rolling Brief Transcript",
      role: "history",
      text: transcriptLines || "- (none)",
    },
    {
      name: "Layer 4 Raw Recent Tail",
      role: "history",
      text: rawTail || "- (none)",
    },
    {
      name: "Layer 5 Recall Pointers",
      role: "recall",
      text: lines(recallPointers),
    },
  ];
};

const renderLayers = (layers: LayerSnapshot[]): string =>
  layers.map((layer) => `[${layer.name}]\n${layer.text}`).join("\n\n");

export const offlineCompactors: OfflineCompactor[] = [
  {
    name: "pi-vcc",
    compact: ({ messages, allMessages, previous }) => {
      const inputTokens = estimateTokens(sourceTextOf(messages));
      const keptTail = allMessages.slice(-2);
      const start = performance.now();
      const summary = compileWithReport({ messages, previousSummary: previous?.activePromptState }, {
        sourceMessageCount: messages.length,
        keptMessageCount: keptTail.length,
        keptTokensEst: estimateTokens(sourceTextOf(keptTail)),
        tokensBefore: estimateTokens(sourceTextOf(allMessages)),
      });
      const elapsed = performance.now() - start;
      return {
        activePromptState: summary.text,
        layers: summary.layers,
        recallCorpus: renderedDocuments(allMessages),
        report: summary.report,
        stats: {
          compactionMs: elapsed,
          estimatedInputTokens: inputTokens,
          estimatedOutputTokens: estimateTokens(summary.text),
        },
      };
    },
  },
  {
    name: "full-rewrite-checkpoint",
    compact: ({ allMessages }) => {
      const start = performance.now();
      const data = buildSections({ blocks: normalize(allMessages) });
      const current = [
        "Objective:",
        lines(data.sessionGoal),
        "Files and artifacts:",
        lines(data.filesAndChanges),
        "Outstanding context:",
        lines(data.outstandingContext),
        "User preferences:",
        lines(data.userPreferences),
      ].join("\n");
      const history = data.briefTranscript || "- (none)";
      const layers: LayerSnapshot[] = [
        { name: "Regenerated Current Checkpoint", role: "current", text: current },
        { name: "Regenerated Transcript", role: "history", text: history },
      ];
      const summary = renderLayers(layers);
      const elapsed = performance.now() - start;
      return {
        activePromptState: summary,
        layers,
        recallCorpus: [],
        stats: {
          compactionMs: elapsed,
          estimatedInputTokens: estimateTokens(sourceTextOf(allMessages)),
          estimatedOutputTokens: estimateTokens(summary),
        },
      };
    },
  },
  {
    name: "cache-aware-layered",
    compact: ({ allMessages }) => {
      const start = performance.now();
      const layers = makeLayeredCheckpoint(allMessages);
      const activePromptState = renderLayers(layers);
      const elapsed = performance.now() - start;
      return {
        activePromptState,
        layers,
        recallCorpus: renderedDocuments(allMessages),
        stats: {
          compactionMs: elapsed,
          estimatedInputTokens: estimateTokens(sourceTextOf(allMessages)),
          estimatedOutputTokens: estimateTokens(activePromptState),
        },
      };
    },
  },
  createModelReferenceCompactor({
    sourceTextOf,
    estimateTokens,
    renderedDocuments,
  }),
];

const forbiddenLeaksOf = (
  terms: Array<ExpectedTerm & { afterTerm?: string }> = [],
  sourceText: string,
  targetText: string,
): string[] =>
  terms
    .filter((term) => {
      const enforce = !term.afterTerm || lowerIncludes(sourceText, term.afterTerm);
      return enforce && lowerIncludes(targetText, term.term);
    })
    .map((term) => term.label);

const cycleMetrics = (
  testCase: CompactionBenchmarkCase,
  compactor: OfflineCompactor,
  cycle: number,
  compactionPoint: number,
  sourceMessages: Message[],
  result: CompactorResult,
  previous: CompactorResult | undefined,
  prompt: PromptSnapshot,
  previousPrompt: PromptSnapshot | undefined,
  includeDiagnostics: boolean,
  includeReports: boolean,
): CycleMetrics => {
  const sourceText = sourceTextOf(sourceMessages);
  const activeText = result.activePromptState;
  const currentText = textForRoles(result, ["current"]);
  const activeProbes = termProbe(testCase.gold.activeTerms, sourceText, activeText);
  const currentProbes = termProbe(testCase.gold.currentTerms ?? [], sourceText, currentText);
  const recallProbes = recallProbe(testCase.gold.recallTerms, sourceText, result.recallCorpus);
  const continuationProbes = termProbe(testCase.gold.continuationTerms ?? [], sourceText, activeText);
  const activeAbsentLeaks = leakProbe(testCase.gold.activeAbsentTerms ?? [], sourceText, activeText)
    .filter((probe) => probe.applicable && probe.found);
  const leakedForbiddenTerms = forbiddenLeaksOf(testCase.gold.forbiddenTerms, sourceText, activeText);
  const leakedForbiddenCurrentTerms = forbiddenLeaksOf(testCase.gold.forbiddenCurrentTerms, sourceText, currentText);
  const changed = summarizeChangedLayers(previous, result);
  const previousTokens = previous ? tokenize(previous.activePromptState).length : 0;
  const currentTokens = tokenize(activeText).length;
  const lcp = previous ? lcpTokens(previous.activePromptState, activeText) : null;
  const denominator = Math.min(previousTokens, currentTokens);
  const promptChanged = summarizeChangedPromptLayers(previousPrompt, prompt);
  const previousPromptTokens = previousPrompt ? tokenize(previousPrompt.text).length : 0;
  const currentPromptTokens = tokenize(prompt.text).length;
  const fullPromptLcp = previousPrompt ? lcpTokens(previousPrompt.text, prompt.text) : null;
  const fullPromptDenominator = Math.min(previousPromptTokens, currentPromptTokens);
  const stablePrefixTokens = previousPrompt ? fullPromptLcp : null;

  return {
    caseId: testCase.id,
    compactor: compactor.name,
    cycle,
    compactionPoint,
    activeChars: activeText.length,
    activeTokensEst: estimateTokens(activeText),
    currentChars: currentText.length,
    currentTokensEst: estimateTokens(currentText),
    fullPromptChars: prompt.text.length,
    fullPromptTokensEst: estimateTokens(prompt.text),
    compactionMs: Number(result.stats.compactionMs.toFixed(3)),
    lcpTokensWithPrevious: lcp,
    lcpTokenRatioWithPrevious: lcp === null || denominator === 0 ? null : Number((lcp / denominator).toFixed(4)),
    firstChangedLayer: changed.firstChangedLayer,
    changedLayers: changed.changedLayers,
    fullPromptLcpTokensWithPrevious: fullPromptLcp,
    fullPromptLcpTokenRatioWithPrevious: fullPromptLcp === null || fullPromptDenominator === 0 ? null : Number((fullPromptLcp / fullPromptDenominator).toFixed(4)),
    firstChangedPromptLayer: promptChanged.firstChangedPromptLayer,
    changedPromptLayers: promptChanged.changedPromptLayers,
    stablePrefixTokens,
    activeTermRecall: ratioOf(activeProbes),
    currentTermRecall: ratioOf(currentProbes),
    recallTermHitRate: ratioOf(recallProbes),
    continuationTermRecall: ratioOf(continuationProbes),
    forbiddenLeakCount: leakedForbiddenTerms.length,
    forbiddenCurrentLeakCount: leakedForbiddenCurrentTerms.length,
    activeAbsentLeakCount: activeAbsentLeaks.length,
    missingActiveTerms: activeProbes.filter((probe) => probe.applicable && !probe.found).map((probe) => probe.label),
    missingCurrentTerms: currentProbes.filter((probe) => probe.applicable && !probe.found).map((probe) => probe.label),
    missingRecallTerms: recallProbes.filter((probe) => probe.applicable && !probe.found).map((probe) => probe.label),
    leakedForbiddenTerms,
    leakedForbiddenCurrentTerms,
    leakedActiveAbsentTerms: activeAbsentLeaks.map((term) => term.label),
    layerSizes: Object.fromEntries(result.layers.map((layer) => [layer.name, layer.text.length])),
    promptLayerSizes: Object.fromEntries(prompt.layers.map((layer) => [layer.name, layer.text.length])),
    promptLayerTokenDeltas: promptChanged.promptLayerTokenDeltas,
    ...(includeDiagnostics && promptChanged.changedPromptLayers.length > 0
      ? { promptLayerDiffs: changedPromptLayerDiffs(previousPrompt, prompt, promptChanged.changedPromptLayers) }
      : {}),
    ...(includeReports && result.report ? { compactionReport: result.report } : {}),
  };
};

const mean = (values: number[]): number | null => {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const meanRounded = (values: number[]): number =>
  Number((values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)).toFixed(3));

const aggregate = (cycles: CycleMetrics[]): BenchmarkRunResult["aggregate"] => {
  const byCompactor = new Map<string, CycleMetrics[]>();
  for (const cycle of cycles) {
    const bucket = byCompactor.get(cycle.compactor) ?? [];
    bucket.push(cycle);
    byCompactor.set(cycle.compactor, bucket);
  }

  return Object.fromEntries([...byCompactor].map(([name, items]) => {
    const nullableMean = (selector: (item: CycleMetrics) => number | null): number | null => {
      const values = items.map(selector).filter((value): value is number => value !== null);
      const result = mean(values);
      return result === null ? null : Number(result.toFixed(4));
    };
    return [name, {
      cycles: items.length,
      meanActiveTokensEst: meanRounded(items.map((item) => item.activeTokensEst)),
      meanCurrentTokensEst: meanRounded(items.map((item) => item.currentTokensEst)),
      meanFullPromptTokensEst: meanRounded(items.map((item) => item.fullPromptTokensEst)),
      meanCompactionMs: meanRounded(items.map((item) => item.compactionMs)),
      meanActiveTermRecall: nullableMean((item) => item.activeTermRecall),
      meanCurrentTermRecall: nullableMean((item) => item.currentTermRecall),
      meanRecallTermHitRate: nullableMean((item) => item.recallTermHitRate),
      meanContinuationTermRecall: nullableMean((item) => item.continuationTermRecall),
      totalForbiddenLeaks: items.reduce((sum, item) => sum + item.forbiddenLeakCount, 0),
      totalForbiddenCurrentLeaks: items.reduce((sum, item) => sum + item.forbiddenCurrentLeakCount, 0),
      totalActiveAbsentLeaks: items.reduce((sum, item) => sum + item.activeAbsentLeakCount, 0),
      meanLcpTokenRatio: nullableMean((item) => item.lcpTokenRatioWithPrevious),
      meanFullPromptLcpTokenRatio: nullableMean((item) => item.fullPromptLcpTokenRatioWithPrevious),
      meanStablePrefixTokens: nullableMean((item) => item.stablePrefixTokens),
    }];
  }));
};

export const failedGatesOf = (cycle: CycleMetrics): string[] => {
  const failures: string[] = [];
  if (cycle.activeTermRecall !== null && cycle.activeTermRecall < 1) failures.push("active-term-recall");
  if (cycle.currentTermRecall !== null && cycle.currentTermRecall < 1) failures.push("current-term-recall");
  if (cycle.recallTermHitRate !== null && cycle.recallTermHitRate < 1) failures.push("recall-hit-rate");
  if (cycle.continuationTermRecall !== null && cycle.continuationTermRecall < 1) failures.push("continuation-term-recall");
  if (cycle.forbiddenLeakCount > 0) failures.push("forbidden-active-leak");
  if (cycle.forbiddenCurrentLeakCount > 0) failures.push("forbidden-current-leak");
  if (cycle.activeAbsentLeakCount > 0) failures.push("active-absent-leak");
  return failures;
};

interface CacheBoundary {
  allowedFirstChangedLayers: string[];
  minStablePrefixTokens: number;
  maxPromptLayerSizes?: Record<string, number>;
}

const CACHE_BOUNDARIES: Record<string, CacheBoundary> = {
  "cache-bust-volatile-next-step": {
    allowedFirstChangedLayers: [
      "Pi MRC Outstanding Context",
      "Pi MRC Brief Transcript",
      "Kept Raw Tail",
    ],
    minStablePrefixTokens: 90,
  },
  "cache-bust-evidence-growth": {
    allowedFirstChangedLayers: [
      "Pi MRC Recent Evidence Handles",
      "Pi MRC Brief Transcript",
      "Kept Raw Tail",
    ],
    minStablePrefixTokens: 110,
  },
  "cache-bust-scope-growth": {
    allowedFirstChangedLayers: [
      "Pi MRC Recent Scope Updates",
      "Pi MRC Brief Transcript",
      "Kept Raw Tail",
    ],
    minStablePrefixTokens: 110,
  },
  "cache-bust-mutable-tail-growth": {
    allowedFirstChangedLayers: [
      "Pi MRC Recent Scope Updates",
      "Pi MRC Recent User Preferences",
      "Pi MRC Recent Evidence Handles",
      "Pi MRC Outstanding Context",
      "Pi MRC Brief Transcript",
      "Kept Raw Tail",
    ],
    minStablePrefixTokens: 140,
    maxPromptLayerSizes: {
      "Pi MRC Recent Scope Updates": 420,
      "Pi MRC Recent User Preferences": 360,
      "Pi MRC Recent Evidence Handles": 260,
    },
  },
  "cache-bust-commit-growth": {
    allowedFirstChangedLayers: [
      "Pi MRC Recent Commits",
      "Pi MRC Brief Transcript",
      "Kept Raw Tail",
    ],
    minStablePrefixTokens: 115,
    maxPromptLayerSizes: {
      "Pi MRC Recent Commits": 520,
    },
  },
  "cache-bust-long-evidence-line": {
    allowedFirstChangedLayers: [
      "Pi MRC Recent Evidence Handles",
      "Pi MRC Brief Transcript",
      "Kept Raw Tail",
    ],
    minStablePrefixTokens: 105,
    maxPromptLayerSizes: {
      "Pi MRC Recent Evidence Handles": 260,
    },
  },
  "cache-bust-long-scope-line": {
    allowedFirstChangedLayers: [
      "Pi MRC Recent Scope Updates",
      "Pi MRC Brief Transcript",
      "Kept Raw Tail",
    ],
    minStablePrefixTokens: 110,
    maxPromptLayerSizes: {
      "Pi MRC Recent Scope Updates": 300,
    },
  },
  "cache-bust-long-preference-line": {
    allowedFirstChangedLayers: [
      "Pi MRC Recent User Preferences",
      "Pi MRC Brief Transcript",
      "Kept Raw Tail",
    ],
    minStablePrefixTokens: 110,
    maxPromptLayerSizes: {
      "Pi MRC Recent User Preferences": 300,
    },
  },
};

export const failedCacheGatesOf = (cycle: CycleMetrics): string[] => {
  const boundary = CACHE_BOUNDARIES[cycle.caseId];
  if (!boundary || cycle.cycle <= 1) return [];
  const failures: string[] = [];
  if (!cycle.firstChangedPromptLayer) {
    failures.push("missing-first-changed-layer");
  } else if (!boundary.allowedFirstChangedLayers.includes(cycle.firstChangedPromptLayer)) {
    failures.push("unexpected-first-changed-layer");
  }
  if ((cycle.stablePrefixTokens ?? 0) < boundary.minStablePrefixTokens) failures.push("stable-prefix-too-small");
  for (const [layer, maxSize] of Object.entries(boundary.maxPromptLayerSizes ?? {})) {
    if ((cycle.promptLayerSizes[layer] ?? 0) > maxSize) failures.push(`recent-layer-too-large:${layer}`);
  }
  return failures;
};

export const runOfflineCompactionBenchmark = async (options: {
  cases?: CompactionBenchmarkCase[];
  compactors?: OfflineCompactor[];
  includeDiagnostics?: boolean;
  includeReports?: boolean;
} = {}): BenchmarkRunResult => {
  const cases = options.cases ?? syntheticCompactionCases;
  const compactors = options.compactors ?? offlineCompactors;
  const cycles: CycleMetrics[] = [];

  for (const testCase of cases) {
    for (const compactor of compactors) {
      let previous: CompactorResult | undefined;
      let previousPrompt: PromptSnapshot | undefined;
      let previousPoint = 0;
      for (const [index, point] of testCase.compactionPoints.entries()) {
        const sourceMessages = testCase.messages.slice(0, point);
        const cycleMessages = testCase.messages.slice(previousPoint, point);
        const result = await compactor.compact({
          messages: cycleMessages,
          allMessages: sourceMessages,
          previous,
          cycle: index + 1,
        });
        const prompt = simulatedPromptOf(result, sourceMessages);
        cycles.push(cycleMetrics(testCase, compactor, index + 1, point, sourceMessages, result, previous, prompt, previousPrompt, Boolean(options.includeDiagnostics), Boolean(options.includeReports)));
        previous = result;
        previousPrompt = prompt;
        previousPoint = point;
      }
    }
  }

  return { cycles, aggregate: aggregate(cycles) };
};
