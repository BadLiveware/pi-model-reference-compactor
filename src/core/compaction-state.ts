import type { SectionData } from "../sections";
import { capBrief, RECALL_NOTE } from "./format";

export type CompiledLayerRole = "current" | "history" | "recall";

export interface CompiledSummaryLayer {
  name: string;
  role: CompiledLayerRole;
  text: string;
}

export interface CompileWithLayersResult {
  text: string;
  layers: CompiledSummaryLayer[];
}

export interface CompactionState {
  current: {
    sessionGoal: string[];
    currentScope: string[];
    recentScopeUpdates: string[];
    filesAndChanges: string[];
    commits: string[];
    recentCommits: string[];
    evidenceHandles: string[];
    recentEvidenceHandles: string[];
    userPreferences: string[];
    recentUserPreferences: string[];
    outstandingContext: string[];
  };
  history: {
    briefTranscript: string;
  };
  recall: {
    note: string;
  };
}

export const CURRENT_SECTION_ORDER = [
  "Session Goal",
  "Files And Changes",
  "Commits",
  "Evidence Handles",
  "User Preferences",
  "Current Scope",
  "Recent Commits",
  "Recent Scope Updates",
  "Recent User Preferences",
  "Recent Evidence Handles",
  "Outstanding Context",
] as const;

export type CurrentSectionName = typeof CURRENT_SECTION_ORDER[number];

const stateKeyOf = (section: CurrentSectionName): keyof CompactionState["current"] => {
  switch (section) {
    case "Session Goal": return "sessionGoal";
    case "Current Scope": return "currentScope";
    case "Recent Scope Updates": return "recentScopeUpdates";
    case "Files And Changes": return "filesAndChanges";
    case "Commits": return "commits";
    case "Recent Commits": return "recentCommits";
    case "Evidence Handles": return "evidenceHandles";
    case "Recent Evidence Handles": return "recentEvidenceHandles";
    case "User Preferences": return "userPreferences";
    case "Recent User Preferences": return "recentUserPreferences";
    case "Outstanding Context": return "outstandingContext";
  }
};

export const RECENT_SECTION_ITEM_LIMITS: Partial<Record<CurrentSectionName, number>> = {
  "Recent Commits": 8,
  "Recent Scope Updates": 6,
  "Recent User Preferences": 6,
  "Recent Evidence Handles": 8,
};

const cappedItems = (title: CurrentSectionName, items: string[]): string[] => {
  const limit = RECENT_SECTION_ITEM_LIMITS[title];
  return limit && items.length > limit ? items.slice(-limit) : items;
};

const section = (title: CurrentSectionName, items: string[]): string => {
  const capped = cappedItems(title, items);
  if (capped.length === 0) return "";
  const body = capped.map((item) => `- ${item}`).join("\n");
  return `[${title}]\n${body}`;
};

export const buildCompactionState = (data: SectionData): CompactionState => ({
  current: {
    sessionGoal: data.sessionGoal,
    currentScope: data.currentScope,
    recentScopeUpdates: [],
    filesAndChanges: data.filesAndChanges,
    commits: data.commits,
    recentCommits: [],
    evidenceHandles: data.evidenceHandles,
    recentEvidenceHandles: [],
    userPreferences: data.userPreferences,
    recentUserPreferences: [],
    outstandingContext: data.outstandingContext,
  },
  history: {
    briefTranscript: data.briefTranscript,
  },
  recall: {
    note: RECALL_NOTE,
  },
});

export const renderCurrentSections = (state: CompactionState): CompiledSummaryLayer[] =>
  CURRENT_SECTION_ORDER
    .map((title) => ({ title, text: section(title, state.current[stateKeyOf(title)]) }))
    .filter((entry) => entry.text)
    .map((entry) => ({
      name: `Pi VCC ${entry.title}`,
      role: "current" as const,
      text: entry.text,
    }));

const emptyCurrent = (): CompactionState["current"] => ({
  sessionGoal: [],
  currentScope: [],
  recentScopeUpdates: [],
  filesAndChanges: [],
  commits: [],
  recentCommits: [],
  evidenceHandles: [],
  recentEvidenceHandles: [],
  userPreferences: [],
  recentUserPreferences: [],
  outstandingContext: [],
});

const parseSectionItems = (text: string): string[] =>
  text.split("\n").slice(1).map((line) => line.replace(/^-\s*/, "").trim()).filter(Boolean);

export const parseCompactionState = (summary: string): CompactionState => {
  const parts = summary.split("\n\n---\n\n").map((part) => part.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  const bodyParts = last === RECALL_NOTE ? parts.slice(0, -1) : parts;
  const currentText = bodyParts[0] ?? "";
  const historyText = bodyParts.slice(1).join("\n\n---\n\n");
  const current = emptyCurrent();

  const headers = [...currentText.matchAll(/^\[(.+?)\]/gm)];
  for (const [index, header] of headers.entries()) {
    const title = header[1] as CurrentSectionName;
    if (!CURRENT_SECTION_ORDER.includes(title)) continue;
    const start = header.index ?? 0;
    const end = headers[index + 1]?.index ?? currentText.length;
    current[stateKeyOf(title)] = parseSectionItems(currentText.slice(start, end).trim());
  }

  return {
    current,
    history: { briefTranscript: historyText },
    recall: { note: RECALL_NOTE },
  };
};

export const renderCompactionState = (
  state: CompactionState,
  options: { includeRecallNote?: boolean } = {},
): CompileWithLayersResult => {
  const layers: CompiledSummaryLayer[] = [
    ...renderCurrentSections(state),
  ];
  if (state.history.briefTranscript) {
    layers.push({
      name: "Pi VCC Brief Transcript",
      role: "history",
      text: capBrief(state.history.briefTranscript),
    });
  }
  if (options.includeRecallNote && layers.length > 0) {
    layers.push({ name: "Pi VCC Recall Note", role: "recall", text: state.recall.note });
  }

  const bodyLayers = options.includeRecallNote ? layers : layers.filter((layer) => layer.role !== "recall");
  const currentText = bodyLayers.filter((layer) => layer.role === "current").map((layer) => layer.text).join("\n\n");
  const historyText = bodyLayers.filter((layer) => layer.role === "history").map((layer) => layer.text).join("\n\n");
  const recallText = bodyLayers.filter((layer) => layer.role === "recall").map((layer) => layer.text).join("\n\n");
  const text = [currentText, historyText, recallText].filter(Boolean).join("\n\n---\n\n");
  return { text, layers: bodyLayers };
};
