/**
 * Context guide extraction from Pi session JSONL files.
 *
 * Reads the current session file and produces a structured Markdown context guide
 * suitable for human/agent review, benchmark inputs, or inter-session continuity.
 * No compaction is triggered — this is purely a read-side extraction.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, basename } from "path";

export interface ContextDumpEntry {
  /** Session entry type */
  type: string;
  /** Entry ID */
  id: string;
  /** Parsed message/compaction data */
  data: Record<string, unknown>;
}

export interface SessionStats {
  totalEntries: number;
  messageEntries: number;
  compactionEntries: number;
  userMessages: number;
  assistantMessages: number;
  sessionsFile: string;
  sessionId: string;
  cwd: string;
  timestamp: string;
}

export interface ExtractedContext {
  stats: SessionStats;
  goal: string[];
  decisions: string[];
  preferences: string[];
  filesRead: Set<string>;
  filesModified: Set<string>;
  recentUserMessages: string[];
  compactionSummaries: string[];
  outstandingContext: string[];
  keyConfig: string[];
}

const MAX_RECENT_USERS = 12;
const MAX_COMPACTION_SUMMARIES = 5;

const parseSessionEntries = (sessionFile: string): ContextDumpEntry[] => {
  try {
    return readFileSync(sessionFile, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          return { type: parsed.type ?? "unknown", id: parsed.id ?? "", data: parsed };
        } catch {
          return undefined;
        }
      })
      .filter((e): e is ContextDumpEntry => e !== undefined);
  } catch {
    return [];
  }
};

const extractSessionStats = (entries: ContextDumpEntry[]): SessionStats | undefined => {
  const header = entries.find((e) => e.type === "session");
  if (!header) return undefined;

  const d = header.data;
  return {
    totalEntries: entries.length,
    messageEntries: entries.filter((e) => e.type === "message").length,
    compactionEntries: entries.filter((e) => e.type === "compaction").length,
    userMessages: entries.filter(
      (e) => e.type === "message" && (e.data as any).message?.role === "user",
    ).length,
    assistantMessages: entries.filter(
      (e) => e.type === "message" && (e.data as any).message?.role === "assistant",
    ).length,
    sessionsFile: "from-entry",
    sessionId: (d.id as string) ?? "",
    cwd: (d.cwd as string) ?? "",
    timestamp: (d.timestamp as string) ?? "",
  };
};

const extractGoalFromSummary = (summary: string): string[] => {
  const goals: string[] = [];
  const goalSection = summary.match(/## Goal\s*\n([\s\S]*?)(?=\n## |$)/);
  if (goalSection) {
    for (const line of goalSection[1].split("\n")) {
      const trimmed = line.replace(/^[-*]\s*/, "").trim();
      if (trimmed && !trimmed.startsWith("[")) {
        goals.push(trimmed);
      }
    }
  }
  return goals;
};

const extractDecisionsFromSummary = (summary: string): string[] => {
  const decisions: string[] = [];
  const section = summary.match(/## Key Decisions\s*\n([\s\S]*?)(?=\n## |$)/);
  if (section) {
    for (const line of section[1].split("\n")) {
      const trimmed = line.replace(/^[-*]\s*/, "").replace(/\*\*/g, "").trim();
      if (trimmed && trimmed.length > 5) {
        decisions.push(trimmed);
      }
    }
  }
  return decisions;
};

const extractFilesFromCompactionDetails = (details: unknown): { read: Set<string>; modified: Set<string> } => {
  const read = new Set<string>();
  const modified = new Set<string>();
  if (!details || typeof details !== "object") return { read, modified };
  const d = details as Record<string, unknown>;
  if (Array.isArray(d.readFiles)) {
    for (const f of d.readFiles) if (typeof f === "string") read.add(f);
  }
  if (Array.isArray(d.modifiedFiles)) {
    for (const f of d.modifiedFiles) if (typeof f === "string") modified.add(f);
  }
  return { read, modified };
};

const extractUserMessageText = (entry: ContextDumpEntry): string | undefined => {
  const msg = (entry.data as any).message;
  if (!msg || msg.role !== "user") return undefined;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text || "")
      .join(" ");
  }
  return undefined;
};
const CONTEXT_RE = /\b(prefer|always|never|don'?t want|must|should not|avoid|keep)\b/i;
const DECISION_RE = /\b(decision|decided|chose|chosen|agreed|resolved|concluded|bootstrap|deploy|chart|helm|namespace)\b/i;

/**
 * Extract structured context from the real context buffer (Pi's context event capture).
 * Prefer this over algorithmic session extraction — actual assembled messages,
 * no regex guesswork, no kubectl noise.
 */
export const extractContextFromBuffer = (bufferPath?: string): ExtractedContext | undefined => {
  try {
    const path = bufferPath ?? "/tmp/pi-vcc-context-buffer.json";
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    const slots = data?.slots;
    if (!Array.isArray(slots) || slots.length === 0) return undefined;
    const messages = slots[slots.length - 1]?.messages;
    if (!Array.isArray(messages)) return undefined;
    return extractContextFromMessages(messages);
  } catch {
    return undefined;
  }
};

/** Extract from raw AgentMessage[] captured by the context event. */
export const extractContextFromMessages = (messages: unknown[]): ExtractedContext => {
  const stats: SessionStats = {
    totalEntries: messages.length, messageEntries: messages.length, compactionEntries: 0,
    userMessages: 0, assistantMessages: 0,
    sessionsFile: "context-buffer", sessionId: "buffer", cwd: "", timestamp: "",
  };
  const goal: string[] = [];
  const decisions: string[] = [];
  const preferences: string[] = [];
  const recentUserMessages: string[] = [];
  const compactionSummaries: string[] = [];
  const keyConfig: string[] = [];
  const seenDecisions = new Set<string>();
  const seenPrefs = new Set<string>();

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = (m.role as string) || "";

    // Compaction summary
    if (role === "compactionSummary" || role === "compaction_summary") {
      stats.compactionEntries++;
      const summary = (m.summary as string) || "";
      if (summary) {
        compactionSummaries.push(summary);
        for (const g of extractGoalFromSummary(summary)) { if (!goal.includes(g)) goal.push(g); }
        for (const d of extractDecisionsFromSummary(summary)) {
          const key = d.toLowerCase();
          if (!seenDecisions.has(key)) { seenDecisions.add(key); decisions.push(d); }
        }
      }
      continue;
    }

    let text = "";
    const content = m.content;
    if (typeof content === "string") { text = content; }
    else if (Array.isArray(content)) {
      text = (content as Array<Record<string, unknown>>)
        .filter((b) => b.type === "text")
        .map((b) => (b.text as string) || "")
        .join(" ");
    }

    if (role === "user") {
      stats.userMessages++;
      recentUserMessages.push(text);
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t.length < 10 || t.length > 250) continue;
        if (CONTEXT_RE.test(t)) { const k = t.toLowerCase(); if (!seenPrefs.has(k)) { seenPrefs.add(k); preferences.push(t); } }
      }
    } else if (role === "assistant") {
      stats.assistantMessages++;
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t.length < 10 || t.length > 300) continue;
        if (DECISION_RE.test(t)) { const k = t.toLowerCase(); if (!seenDecisions.has(k)) { seenDecisions.add(k); decisions.push(t); } }
      }
    }

    // Extract cwd
    if (!stats.cwd) {
      const cwdMatch = text.match(/\/home\/fl\/code\/[\w.-]+(?:\/[\w.-]+)*/);
      if (cwdMatch) stats.cwd = cwdMatch[0];
    }
  }

  return {
    stats, goal: goal.slice(0, 6), decisions: decisions.slice(0, 20), preferences: preferences.slice(0, 15),
    filesRead: new Set(), filesModified: new Set(),
    recentUserMessages: recentUserMessages.slice(-MAX_RECENT_USERS),
    compactionSummaries: compactionSummaries.slice(-MAX_COMPACTION_SUMMARIES),
    outstandingContext: [], keyConfig: keyConfig.slice(0, 20),
  };
};

/**
 * Extract structured context from a session file.
 */
export const extractContext = (sessionFile: string): ExtractedContext | undefined => {
  const entries = parseSessionEntries(sessionFile);
  if (entries.length === 0) return undefined;

  const stats = extractSessionStats(entries);
  if (!stats) return undefined;

  const goal: string[] = [];
  const decisions: string[] = [];
  const preferences: string[] = [];
  const filesRead = new Set<string>();
  const filesModified = new Set<string>();
  const recentUserMessages: string[] = [];
  const compactionSummaries: string[] = [];
  const outstandingContext: string[] = [];
  const keyConfig: string[] = [];

  const seenDecisions = new Set<string>();
  const seenPrefs = new Set<string>();

  for (const entry of entries) {
    // Compaction summaries
    if (entry.type === "compaction") {
      const summary = (entry.data as any).summary as string;
      if (summary) {
        compactionSummaries.push(summary);
        // Extract goal from summary
        for (const g of extractGoalFromSummary(summary)) {
          if (!goal.includes(g)) goal.push(g);
        }
        // Extract decisions from summary
        for (const d of extractDecisionsFromSummary(summary)) {
          const key = d.toLowerCase();
          if (!seenDecisions.has(key)) {
            seenDecisions.add(key);
            decisions.push(d);
          }
        }
      }
      // Extract files from details
      const { read, modified } = extractFilesFromCompactionDetails((entry.data as any).details);
      for (const f of read) filesRead.add(f);
      for (const f of modified) filesModified.add(f);
      continue;
    }

    // User messages
    const userText = extractUserMessageText(entry);
    if (userText) {
      recentUserMessages.push(userText);
      // Extract preferences
      for (const line of userText.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length < 10 || trimmed.length > 250) continue;
        if (CONTEXT_RE.test(trimmed)) {
          const key = trimmed.toLowerCase();
          if (!seenPrefs.has(key)) {
            seenPrefs.add(key);
            preferences.push(trimmed);
          }
        }
      }
      continue;
    }

    // Assistant messages — extract decisions/config
    const msg = (entry.data as any).message;
    if (msg?.role === "assistant") {
      const blocks = msg.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            for (const line of block.text.split("\n")) {
              const trimmed = line.trim();
              if (trimmed.length < 10 || trimmed.length > 300) continue;
              if (DECISION_RE.test(trimmed)) {
                const key = trimmed.toLowerCase();
                if (!seenDecisions.has(key)) {
                  seenDecisions.add(key);
                  decisions.push(trimmed);
                }
              }
              if (/\b(kubectl|helm|chart|namespace|deployment|ingress|CRD|cert-manager|operator)\b/i.test(trimmed)) {
                const key = trimmed.toLowerCase();
                if (!keyConfig.includes(trimmed)) {
                  keyConfig.push(trimmed);
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    stats,
    goal: goal.slice(0, 6),
    decisions: decisions.slice(0, 20),
    preferences: preferences.slice(0, 15),
    filesRead,
    filesModified,
    recentUserMessages: recentUserMessages.slice(-MAX_RECENT_USERS),
    compactionSummaries: compactionSummaries.slice(-MAX_COMPACTION_SUMMARIES),
    outstandingContext: outstandingContext.slice(0, 15),
    keyConfig: keyConfig.slice(0, 20),
  };
};

/**
 * Format extracted context as a Markdown guide.
 */
export const formatContextGuide = (ctx: ExtractedContext, sessionFile: string): string => {
  const s = ctx.stats;
  const projectName = s.cwd.split("/").pop() || basename(sessionFile, ".jsonl");
  const lines: string[] = [];

  lines.push(`# Context Guide: ${projectName}`);
  lines.push(`Extracted from ${basename(sessionFile)}`);
  lines.push("");

  lines.push("## Session");
  lines.push(`- **Project**: ${s.cwd}`);
  lines.push(`- **Session ID**: ${s.sessionId}`);
  lines.push(`- **Date**: ${s.timestamp.split("T")[0] ?? s.timestamp}`);
  lines.push(`- **Entries**: ${s.totalEntries} (${s.messageEntries} messages, ${s.compactionEntries} compactions)`);
  lines.push(`- **User messages**: ${s.userMessages}, Assistant: ${s.assistantMessages}`);
  lines.push("");

  if (ctx.goal.length > 0) {
    lines.push("## Goal");
    for (const g of ctx.goal) lines.push(`- ${g}`);
    lines.push("");
  }

  if (ctx.decisions.length > 0) {
    lines.push("## Key Decisions");
    for (const d of ctx.decisions.slice(0, 15)) lines.push(`- ${d}`);
    lines.push("");
  }

  if (ctx.preferences.length > 0) {
    lines.push("## Preferences / Constraints");
    for (const p of ctx.preferences.slice(0, 10)) lines.push(`- ${p}`);
    lines.push("");
  }

  if (ctx.filesModified.size > 0) {
    lines.push("## Modified Files");
    for (const f of [...ctx.filesModified].sort().slice(0, 25)) lines.push(`- ${f}`);
    lines.push("");
  }

  if (ctx.filesRead.size > 0) {
    const readOnly = [...ctx.filesRead].filter((f) => !ctx.filesModified.has(f)).sort();
    if (readOnly.length > 0) {
      lines.push("## Read Files");
      for (const f of readOnly.slice(0, 20)) lines.push(`- ${f}`);
      lines.push("");
    }
  }

  if (ctx.recentUserMessages.length > 0) {
    lines.push("## Recent User Messages");
    for (let i = 0; i < ctx.recentUserMessages.length; i++) {
      const preview = ctx.recentUserMessages[i].replace(/\n/g, " ").slice(0, 200);
      lines.push(`${i + 1}. ${preview}`);
    }
    lines.push("");
  }

  if (ctx.keyConfig.length > 0) {
    lines.push("## Key Configuration / Architecture");
    const unique = [...new Set(ctx.keyConfig)].slice(0, 15);
    for (const k of unique) lines.push(`- ${k}`);
    lines.push("");
  }

  if (ctx.compactionSummaries.length > 0) {
    lines.push("## Compaction Summary Previews");
    for (const s of ctx.compactionSummaries.slice(-3)) {
      const preview = s.replace(/\n/g, " ").slice(0, 300);
      lines.push(`- ${preview}`);
    }
    lines.push("");
  }

  return lines.join("\n");
};

/**
 * Write context guide to disk. Returns the output path.
 */
export const writeContextGuide = (ctx: ExtractedContext, sessionFile: string, outputPath?: string): string => {
  const markdown = formatContextGuide(ctx, sessionFile);
  const out = outputPath ?? `/tmp/pi-vcc-context-guide-${Date.now()}.md`;
  const dir = dirname(out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(out, markdown);
  return out;
};

/**
 * Dump raw session JSONL of the active branch path.
 */
export const dumpRawSessionJsonl = (sessionFile: string, outputPath?: string): string => {
  const entries = parseSessionEntries(sessionFile);
  const out = outputPath ?? `/tmp/pi-vcc-raw-session-${Date.now()}.jsonl`;
  const dir = dirname(out);
  mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e.data)).join("\n") + "\n";
  writeFileSync(out, lines);
  return out;
};
