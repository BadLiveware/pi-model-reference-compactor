import type { SectionData } from "../sections";

const section = (title: string, items: string[]): string => {
  if (items.length === 0) return "";
  const body = items.map((i) => `- ${i}`).join("\n");
  return `[${title}]\n${body}`;
};

const BRIEF_MAX_LINES = 120;

export const capBrief = (text: string): string => {
  const lines = text.split("\n");
  if (lines.length <= BRIEF_MAX_LINES) return text;
  const omitted = lines.length - BRIEF_MAX_LINES;
  const kept = lines.slice(-BRIEF_MAX_LINES);
  // Find first section header to avoid cutting mid-section
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

export const RECALL_NOTE =
  "Use exact MRC handles when available. Broad/fuzzy transcript search is outside pi-mrc. " +
  "Do not redo work already completed.";

export const formatSummary = (data: SectionData): string => {
  const headerParts = [
    section("Session Goal", data.sessionGoal),
    section("Current Scope", data.currentScope),
    section("Files And Changes", data.filesAndChanges),
    section("Commits", data.commits),
    section("Evidence Handles", data.evidenceHandles),
    section("User Preferences", data.userPreferences),
    section("Outstanding Context", data.outstandingContext),
  ].filter(Boolean);

  const parts: string[] = [];
  if (headerParts.length > 0) {
    parts.push(headerParts.join("\n\n"));
  }
  if (data.briefTranscript) {
    parts.push(capBrief(data.briefTranscript));
  }

  if (parts.length === 0) return "";

  // NOTE: RECALL_NOTE is intentionally NOT appended here.
  // It is appended once by `compile()` at the very end, after merge-with-previous,
  // to avoid the note compounding inside the brief transcript across compactions.
  return parts.join("\n\n---\n\n");
};
