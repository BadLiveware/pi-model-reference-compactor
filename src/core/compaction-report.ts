import {
  CURRENT_SECTION_ORDER,
  RECENT_SECTION_ITEM_LIMITS,
  type CompactionState,
  type CompiledLayerRole,
  type CompiledSummaryLayer,
  type CurrentSectionName,
} from "./compaction-state";

export const PI_VCC_COMPACTION_REPORT_TYPE = "pi-vcc-compaction-report";

export type CompactionReportSectionPolicy =
  | "stable-current"
  | "recent-volatile"
  | "history"
  | "recall";

export type CompactionReportSectionStatus = "new" | "changed" | "unchanged";

export interface CompactionReportCap {
  section: string;
  before: number;
  after: number;
  dropped: number;
}

export interface CompactionReportSection {
  name: string;
  title: string;
  role: CompiledLayerRole;
  policy: CompactionReportSectionPolicy;
  status: CompactionReportSectionStatus;
  itemCount: number;
  renderedItemCount: number;
  chars: number;
  limit?: number;
  capped?: CompactionReportCap;
  reason: string;
  preview: string[];
}

export interface BuildCompactionReportInput {
  layers: CompiledSummaryLayer[];
  previousLayers: CompiledSummaryLayer[];
  state: CompactionState;
  sourceMessageCount: number;
  keptMessageCount: number;
  keptTokensEst: number;
  skippedInternalMessageCount?: number;
  tokensBefore: number;
  previousSummaryUsed: boolean;
  summaryText: string;
}

export interface PiVccCompactionReport {
  compactor: "pi-vcc";
  version: 1;
  sourceMessageCount: number;
  keptMessageCount: number;
  keptTokensEst: number;
  skippedInternalMessageCount: number;
  tokensBefore: number;
  summaryChars: number;
  previousSummaryUsed: boolean;
  firstChangedLayer?: string;
  firstChangedPolicy?: CompactionReportSectionPolicy;
  stableSectionCount: number;
  stableUnchangedCount: number;
  stableChangedSections: string[];
  recentSectionCount: number;
  cappedSections: CompactionReportCap[];
  sections: CompactionReportSection[];
  warnings: string[];
}

const STABLE_CURRENT_SECTIONS = new Set<string>([
  "Session Goal",
  "Files And Changes",
  "Commits",
  "Evidence Handles",
  "User Preferences",
  "Current Scope",
]);

const RECENT_VOLATILE_SECTIONS = new Set<string>([
  "Recent Commits",
  "Recent Scope Updates",
  "Recent User Preferences",
  "Recent Evidence Handles",
  "Outstanding Context",
]);

const titleOfLayer = (name: string): string =>
  name.startsWith("Pi VCC ") ? name.slice("Pi VCC ".length) : name;

const isCurrentSectionName = (title: string): title is CurrentSectionName =>
  (CURRENT_SECTION_ORDER as readonly string[]).includes(title);

const stateItemsOf = (state: CompactionState, title: CurrentSectionName): string[] => {
  switch (title) {
    case "Session Goal": return state.current.sessionGoal;
    case "Files And Changes": return state.current.filesAndChanges;
    case "Commits": return state.current.commits;
    case "Recent Commits": return state.current.recentCommits;
    case "Evidence Handles": return state.current.evidenceHandles;
    case "User Preferences": return state.current.userPreferences;
    case "Current Scope": return state.current.currentScope;
    case "Recent Scope Updates": return state.current.recentScopeUpdates;
    case "Recent User Preferences": return state.current.recentUserPreferences;
    case "Recent Evidence Handles": return state.current.recentEvidenceHandles;
    case "Outstanding Context": return state.current.outstandingContext;
  }
};

const policyOf = (title: string, role: CompiledLayerRole): CompactionReportSectionPolicy => {
  if (role === "history") return "history";
  if (role === "recall") return "recall";
  if (RECENT_VOLATILE_SECTIONS.has(title)) return "recent-volatile";
  if (STABLE_CURRENT_SECTIONS.has(title)) return "stable-current";
  return "stable-current";
};

const reasonOf = (policy: CompactionReportSectionPolicy): string => {
  switch (policy) {
    case "stable-current":
      return "Durable current state kept early for continuity and cache reuse.";
    case "recent-volatile":
      return "Additive or volatile state isolated late so stable sections can stay cacheable.";
    case "history":
      return "Condensed transcript context for coherence when exact history is not needed inline.";
    case "recall":
      return "Pointer that older exact detail remains recoverable from transcript/recall.";
  }
};

const statusOf = (
  layer: CompiledSummaryLayer,
  previousByName: Map<string, string>,
): CompactionReportSectionStatus => {
  if (!previousByName.has(layer.name)) return "new";
  return previousByName.get(layer.name) === layer.text ? "unchanged" : "changed";
};

const nonEmptyLines = (text: string): string[] =>
  text.split("\n").map((line) => line.trim()).filter(Boolean);

const renderedItemCountOf = (layer: CompiledSummaryLayer): number => {
  const bulletCount = (layer.text.match(/^- /gm) ?? []).length;
  if (bulletCount > 0) return bulletCount;
  if (layer.role === "recall") return layer.text.trim() ? 1 : 0;
  return nonEmptyLines(layer.text).length;
};

const itemCountOf = (state: CompactionState, layer: CompiledSummaryLayer, title: string): number => {
  if (isCurrentSectionName(title)) return stateItemsOf(state, title).length;
  if (layer.role === "recall") return layer.text.trim() ? 1 : 0;
  return nonEmptyLines(layer.text).length;
};

const previewOf = (layer: CompiledSummaryLayer): string[] =>
  nonEmptyLines(layer.text)
    .filter((line) => !/^\[.+?\]$/.test(line))
    .map((line) => line.replace(/^-\s*/, ""))
    .slice(0, 2)
    .map((line) => line.length > 140 ? `${line.slice(0, 137)}...` : line);

const capOf = (title: string, itemCount: number): CompactionReportCap | undefined => {
  if (!isCurrentSectionName(title)) return undefined;
  const limit = RECENT_SECTION_ITEM_LIMITS[title];
  if (!limit || itemCount <= limit) return undefined;
  return {
    section: title,
    before: itemCount,
    after: limit,
    dropped: itemCount - limit,
  };
};

export const buildCompactionReport = (input: BuildCompactionReportInput): PiVccCompactionReport => {
  const previousByName = new Map(input.previousLayers.map((layer) => [layer.name, layer.text]));
  const sections = input.layers.map((layer): CompactionReportSection => {
    const title = titleOfLayer(layer.name);
    const policy = policyOf(title, layer.role);
    const itemCount = itemCountOf(input.state, layer, title);
    const renderedItemCount = renderedItemCountOf(layer);
    const capped = capOf(title, itemCount);
    return {
      name: layer.name,
      title,
      role: layer.role,
      policy,
      status: statusOf(layer, previousByName),
      itemCount,
      renderedItemCount,
      chars: layer.text.length,
      limit: isCurrentSectionName(title) ? RECENT_SECTION_ITEM_LIMITS[title] : undefined,
      capped,
      reason: reasonOf(policy),
      preview: previewOf(layer),
    };
  });

  const firstChanged = sections.find((section) => section.status !== "unchanged");
  const stableSections = sections.filter((section) => section.policy === "stable-current");
  const stableChangedSections = stableSections
    .filter((section) => section.status !== "unchanged")
    .map((section) => section.title);
  const cappedSections = sections.flatMap((section) => section.capped ? [section.capped] : []);
  const warnings: string[] = [];

  if (input.previousSummaryUsed && firstChanged?.policy === "stable-current") {
    warnings.push(`First changed layer is stable/current: ${firstChanged.title}`);
  }
  for (const cap of cappedSections) {
    warnings.push(`${cap.section} capped from ${cap.before} to ${cap.after} items`);
  }

  return {
    compactor: "pi-vcc",
    version: 1,
    sourceMessageCount: input.sourceMessageCount,
    keptMessageCount: input.keptMessageCount,
    keptTokensEst: input.keptTokensEst,
    skippedInternalMessageCount: input.skippedInternalMessageCount ?? 0,
    tokensBefore: input.tokensBefore,
    summaryChars: input.summaryText.length,
    previousSummaryUsed: input.previousSummaryUsed,
    firstChangedLayer: firstChanged?.name,
    firstChangedPolicy: firstChanged?.policy,
    stableSectionCount: stableSections.length,
    stableUnchangedCount: stableSections.filter((section) => section.status === "unchanged").length,
    stableChangedSections,
    recentSectionCount: sections.filter((section) => section.policy === "recent-volatile").length,
    cappedSections,
    sections,
    warnings,
  };
};

const plural = (n: number, singular: string, pluralForm = `${singular}s`): string =>
  `${n} ${n === 1 ? singular : pluralForm}`;

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const shortLayerName = (name: string | undefined): string =>
  name ? titleOfLayer(name) : "none";

export const formatCompactionReportSummaryLine = (report: PiVccCompactionReport): string => {
  const stable = report.previousSummaryUsed
    ? `${report.stableUnchangedCount}/${report.stableSectionCount} stable unchanged`
    : `${plural(report.stableSectionCount, "stable section")}`;
  const firstChange = report.previousSummaryUsed
    ? shortLayerName(report.firstChangedLayer)
    : "new summary";
  const caps = report.cappedSections.length > 0
    ? `; capped ${plural(report.cappedSections.length, "section")}`
    : "";
  const warnings = report.warnings.length > 0
    ? `; ${plural(report.warnings.length, "warning")}`
    : "";
  return `Compacted ${plural(report.sourceMessageCount, "message")} from ~${formatTokens(report.tokensBefore)} tok; kept ${report.keptMessageCount} (~${formatTokens(report.keptTokensEst)} tok); ${stable}; first change: ${firstChange}${caps}${warnings}.`;
};

export const formatCompactionReportMessageContent = (report: PiVccCompactionReport): string => {
  const lines = [
    formatCompactionReportSummaryLine(report),
    "Full pi-vcc compaction report is stored on this UI message for inspection.",
  ];
  if (report.skippedInternalMessageCount > 0) {
    lines.push(`Skipped ${plural(report.skippedInternalMessageCount, "prior pi-vcc report message")} while summarizing.`);
  }
  return lines.join("\n");
};

const statusGlyph = (status: CompactionReportSectionStatus): string => {
  switch (status) {
    case "unchanged": return "✓";
    case "changed": return "~";
    case "new": return "+";
  }
};

const policyLabel = (policy: CompactionReportSectionPolicy): string => {
  switch (policy) {
    case "stable-current": return "stable";
    case "recent-volatile": return "recent";
    case "history": return "history";
    case "recall": return "recall";
  }
};

export const formatCompactionReportCard = (
  report: PiVccCompactionReport,
  options: { expanded?: boolean } = {},
): string => {
  if (!options.expanded) return `${formatCompactionReportSummaryLine(report)} Expand for section-level details.`;

  const lines: string[] = [
    formatCompactionReportSummaryLine(report),
    "",
    "Sanity check",
    `- Previous summary used: ${report.previousSummaryUsed ? "yes" : "no"}`,
    `- Summary size: ${report.summaryChars.toLocaleString()} chars`,
    `- First changed layer: ${shortLayerName(report.firstChangedLayer)}`,
    `- Stable/current unchanged: ${report.stableUnchangedCount}/${report.stableSectionCount}`,
  ];

  if (report.stableChangedSections.length > 0) {
    lines.push(`- Stable/current changed: ${report.stableChangedSections.join(", ")}`);
  }
  if (report.cappedSections.length > 0) {
    lines.push(`- Caps applied: ${report.cappedSections.map((cap) => `${cap.section} ${cap.before}->${cap.after}`).join(", ")}`);
  }
  if (report.skippedInternalMessageCount > 0) {
    lines.push(`- Skipped internal report cards: ${report.skippedInternalMessageCount}`);
  }
  if (report.warnings.length > 0) {
    lines.push("", "Warnings", ...report.warnings.map((warning) => `! ${warning}`));
  }

  lines.push("", "Sections");
  for (const section of report.sections) {
    const cap = section.capped ? `, capped ${section.capped.before}->${section.capped.after}` : "";
    lines.push(`${statusGlyph(section.status)} ${section.title} — ${policyLabel(section.policy)}, ${section.status}, ${section.renderedItemCount}/${section.itemCount} items, ${section.chars} chars${cap}`);
    if (section.preview.length > 0) {
      lines.push(...section.preview.map((preview) => `  ${preview}`));
    }
  }

  lines.push(
    "",
    "Deep dive",
    "- The full machine-readable report is stored in this message's details and in compaction.details.report.",
    "- Run /pi-vcc-report for Markdown/JSON artifacts, /pi-vcc-report show for inline detail, or /pi-vcc-report list for older reports.",
  );

  return lines.join("\n");
};
