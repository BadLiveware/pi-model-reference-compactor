import type { Message } from "@mariozechner/pi-ai";
import type { FileOps } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { buildSections } from "./build-sections";
import { capBrief, RECALL_NOTE } from "./format";
import { applyPreferenceCorrections } from "../extract/preferences";
import {
  buildCompactionState,
  CURRENT_SECTION_ORDER,
  parseCompactionState,
  renderCompactionState,
  type CompactionState,
  type CompiledLayerRole,
  type CompiledSummaryLayer,
  type CompileWithLayersResult,
} from "./compaction-state";
import {
  buildCompactionReport,
  type PiVccCompactionReport,
} from "./compaction-report";

export interface CompileInput {
  messages: Message[];
  previousSummary?: string;
  fileOps?: FileOps;
}

export interface CompileReportContext {
  sourceMessageCount: number;
  keptMessageCount: number;
  keptTokensEst: number;
  skippedInternalMessageCount?: number;
  tokensBefore: number;
}

export interface CompileWithReportResult extends CompileWithLayersResult {
  report: PiVccCompactionReport;
}

export type { CompiledLayerRole, CompiledSummaryLayer, CompileWithLayersResult } from "./compaction-state";

const HEADER_NAMES = ["Evidence Handles", "Recent Evidence Handles", "Recent Commits", "Recent User Preferences", "Recent Scope Updates", ...CURRENT_SECTION_ORDER];

const SEPARATOR = "\n\n---\n\n";

/** Extract a named section from summary text */
const sectionOf = (text: string, header: string): string => {
  const tag = `[${header}]`;
  const start = text.indexOf(tag);
  if (start < 0) return "";
  const after = text.slice(start);
  // Find next section header or separator
  const nextSection = HEADER_NAMES
    .filter((h) => h !== header)
    .map((h) => after.indexOf(`[${h}]`))
    .filter((n) => n > 0);
  const nextSep = after.indexOf("\n\n---\n\n");
  const candidates = [...nextSection, ...(nextSep > 0 ? [nextSep] : [])].sort((a, b) => a - b);
  const end = candidates[0];
  return (end ? after.slice(0, end) : after).trim();
};

/** Extract the brief transcript part (everything after ---) */
const briefOf = (text: string): string => {
  const idx = text.indexOf(SEPARATOR);
  if (idx >= 0) return text.slice(idx + SEPARATOR.length).trim();
  // A fresh compaction can contain only brief transcript with no header section,
  // in which case there is no separator to split on.
  const trimmed = text.trim();
  if (!trimmed) return "";
  return HEADER_NAMES.some((header) => trimmed.startsWith(`[${header}]`)) ? "" : trimmed;
};

/** Merge a header section */
const mergeHeaderSection = (header: string, prev: string, fresh: string): string => {
  if (header === "Evidence Handles") return prev || fresh;
  if (header === "Commits") return prev || fresh;
  if (header === "User Preferences" && prev && fresh && !/\b(correction|never)\b/i.test(fresh)) return prev;
  // Keep established scope stable; additive fresh scope is rendered later.
  if (header === "Current Scope") return prev || fresh;
  // Recent read context is a short-lived working map for immediate continuation.
  if (header === "Recent Read Context") return fresh;
  // Outstanding Context is volatile -- always use fresh only.
  if (header === "Outstanding Context") return fresh;
  if (!prev) return fresh;
  if (!fresh) return prev;

  // Files And Changes: merge by category (Modified/Created/Read), dedup paths
  if (header === "Files And Changes") {
    return mergeFileLines(prev, fresh);
  }

  // Sticky list sections: line-level dedup, cap
  const isClean = (l: string) => l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");
  const prevLines = prev.split("\n").filter(isClean);
  const freshLines = fresh.split("\n").filter(isClean);
  const combinedRaw = [...new Set([...prevLines, ...freshLines])];
  const combined = header === "User Preferences"
    ? applyPreferenceCorrections(combinedRaw.map((line) => line.replace(/^-\s*/, ""))).map((line) => `- ${line}`)
    : combinedRaw;
  const CAP = header === "Session Goal" ? 8 : header === "Commits" ? 8 : header === "Evidence Handles" ? 20 : 15;
  const capped = combined.length > CAP ? combined.slice(-CAP) : combined;
  if (capped.length === 0) return "";
  return `[${header}]\n${capped.join("\n")}`;
};

/** Merge Files And Changes by category, dedup paths across compactions */
const mergeFileLines = (prev: string, fresh: string): string => {
  const categories = ["Modified", "Created", "Read"] as const;
  const merged: Record<string, Set<string>> = {};
  for (const cat of categories) merged[cat] = new Set();

  // Parse "- Modified: a, b, c (+N more)" lines from both prev and fresh
  for (const text of [prev, fresh]) {
    for (const line of text.split("\n")) {
      for (const cat of categories) {
        const prefix = `- ${cat}: `;
        if (!line.startsWith(prefix)) continue;
        let rest = line.slice(prefix.length);
        // Strip overflow suffixes
        rest = rest.replace(/\s*\(\+(?:\d+\s+)?more\)\s*$/, "");
        for (const p of rest.split(",")) {
          const trimmed = p.trim();
          if (trimmed) merged[cat].add(trimmed);
        }
      }
    }
  }

  // Dedup: if already in Modified, drop from Created (file existed before)
  for (const p of merged.Modified) merged.Created.delete(p);

  const cap = (set: Set<string>, limit: number) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + " (+more)";
  };

  const lines: string[] = [];
  if (merged.Modified.size > 0) lines.push(`- Modified: ${cap(merged.Modified, 10)}`);
  if (merged.Created.size > 0) lines.push(`- Created: ${cap(merged.Created, 10)}`);
  if (merged.Read.size > 0) lines.push(`- Read: ${cap(merged.Read, 10)}`);
  if (lines.length === 0) return "";
  return `[Files And Changes]\n${lines.join("\n")}`;
};

const cleanListItemsOf = (section: string): string[] =>
  section.split("\n").filter((line) => line.startsWith("- "));

const evidenceItemsOf = cleanListItemsOf;

const freshRecentEvidenceSection = (prevEvidence: string, freshEvidence: string): string => {
  if (!prevEvidence || !freshEvidence) return "";
  const previous = new Set(evidenceItemsOf(prevEvidence));
  const freshOnly = evidenceItemsOf(freshEvidence).filter((line) => !previous.has(line));
  return freshOnly.length > 0 ? `[Recent Evidence Handles]\n${freshOnly.join("\n")}` : "";
};

const freshRecentCommitsSection = (prevCommits: string, freshCommits: string): string => {
  if (!prevCommits || !freshCommits) return "";
  const previous = new Set(cleanListItemsOf(prevCommits));
  const freshOnly = cleanListItemsOf(freshCommits).filter((line) => !previous.has(line));
  return freshOnly.length > 0 ? `[Recent Commits]\n${freshOnly.join("\n")}` : "";
};

const freshRecentScopeSection = (prevScope: string, freshScope: string): string => {
  if (!prevScope || !freshScope) return "";
  const previous = new Set(cleanListItemsOf(prevScope));
  const freshOnly = cleanListItemsOf(freshScope).filter((line) => !previous.has(line));
  return freshOnly.length > 0 ? `[Recent Scope Updates]\n${freshOnly.join("\n")}` : "";
};

const freshRecentUserPreferencesSection = (prevPreferences: string, freshPreferences: string): string => {
  if (!prevPreferences || !freshPreferences || /\b(correction|never)\b/i.test(freshPreferences)) return "";
  const previous = new Set(cleanListItemsOf(prevPreferences));
  const freshOnly = cleanListItemsOf(freshPreferences).filter((line) => !previous.has(line));
  return freshOnly.length > 0 ? `[Recent User Preferences]\n${freshOnly.join("\n")}` : "";
};

const mergeBriefTranscript = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return prev;
  return prev + "\n\n" + fresh;
};

const demoteFreshGoalToScope = (fresh: string): string => {
  const goal = sectionOf(fresh, "Session Goal");
  if (!goal) return fresh;

  const goalLines = goal.split("\n").slice(1).filter((line) => line.startsWith("- "));
  const withoutGoal = fresh
    .replace(goal, "")
    .replace(/^\s+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (goalLines.length === 0) return withoutGoal;

  const currentScope = sectionOf(withoutGoal, "Current Scope");
  if (currentScope) {
    return withoutGoal.replace(currentScope, `${currentScope}\n${goalLines.join("\n")}`);
  }

  const scopeSection = `[Current Scope]\n${goalLines.join("\n")}`;
  return withoutGoal ? `${scopeSection}\n\n${withoutGoal}` : scopeSection;
};

const mergePrevious = (prev: string, fresh: string): string => {
  const mergeFresh = demoteFreshGoalToScope(fresh);
  // Merge header sections
  const recentEvidence = freshRecentEvidenceSection(sectionOf(prev, "Evidence Handles"), sectionOf(mergeFresh, "Evidence Handles"));
  const recentCommits = freshRecentCommitsSection(sectionOf(prev, "Commits"), sectionOf(mergeFresh, "Commits"));
  const recentUserPreferences = freshRecentUserPreferencesSection(sectionOf(prev, "User Preferences"), sectionOf(mergeFresh, "User Preferences"));
  const recentScope = freshRecentScopeSection(sectionOf(prev, "Current Scope"), sectionOf(mergeFresh, "Current Scope"));
  const headers = HEADER_NAMES
    .map((header) => {
      if (header === "Recent Evidence Handles") return recentEvidence;
      if (header === "Recent Commits") return recentCommits;
      if (header === "Recent User Preferences") return recentUserPreferences;
      if (header === "Recent Scope Updates") return recentScope;
      const freshSec = sectionOf(mergeFresh, header);
      const prevSec = sectionOf(prev, header);
      return mergeHeaderSection(header, prevSec, freshSec);
    })
    .filter(Boolean);

  // Merge brief transcript
  const prevBrief = briefOf(prev);
  const freshBrief = briefOf(mergeFresh);
  const mergedBrief = mergeBriefTranscript(prevBrief, freshBrief);

  const parts: string[] = [];
  if (headers.length > 0) {
    parts.push(headers.join("\n\n"));
  }
  if (mergedBrief) {
    parts.push(capBrief(mergedBrief));
  }

  return parts.join(SEPARATOR);
};

interface CompilationBuild {
  state: CompactionState;
  previousLayers: CompiledSummaryLayer[];
  rendered: CompileWithLayersResult;
}

const buildCompilation = (input: CompileInput): CompilationBuild => {
  const blocks = filterNoise(normalize(input.messages));
  const data = buildSections({ blocks });
  const fresh = renderCompactionState(buildCompactionState(data)).text;
  // Strip any legacy RECALL_NOTE baked into prev summary (pre-fix format)
  // so merge doesn't re-stack it inside the brief.
  const prev = input.previousSummary
    ? stripRecallNote(input.previousSummary)
    : undefined;
  const merged = prev ? mergePrevious(prev, fresh) : fresh;
  const state = parseCompactionState(merged);
  const previousLayers = prev
    ? renderCompactionState(parseCompactionState(prev), { includeRecallNote: true }).layers
    : [];
  const rendered = merged
    ? renderCompactionState(state, { includeRecallNote: true })
    : { text: "", layers: [] };
  return { state, previousLayers, rendered };
};

export const compile = (input: CompileInput): string => compileWithLayers(input).text;

export const compileWithLayers = (input: CompileInput): CompileWithLayersResult =>
  buildCompilation(input).rendered;

export const compileWithReport = (
  input: CompileInput,
  context: CompileReportContext,
): CompileWithReportResult => {
  const compilation = buildCompilation(input);
  return {
    ...compilation.rendered,
    report: buildCompactionReport({
      layers: compilation.rendered.layers,
      previousLayers: compilation.previousLayers,
      state: compilation.state,
      sourceMessageCount: context.sourceMessageCount,
      keptMessageCount: context.keptMessageCount,
      keptTokensEst: context.keptTokensEst,
      skippedInternalMessageCount: context.skippedInternalMessageCount,
      tokensBefore: context.tokensBefore,
      previousSummaryUsed: Boolean(input.previousSummary?.trim()),
      summaryText: compilation.rendered.text,
    }),
  };
};

const stripRecallNote = (text: string): string => {
  // Remove trailing RECALL_NOTE (and any separators surrounding it) if present.
  // Handles both current format (---\n\nNOTE) and bare trailing NOTE.
  const idx = text.lastIndexOf(RECALL_NOTE);
  if (idx < 0) return text;
  return text.slice(0, idx).replace(/\s*(?:\n\n---\n\n)?\s*$/, "").trimEnd();
};
