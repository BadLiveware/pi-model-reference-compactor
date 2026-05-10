import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { writeFileSync } from "fs";
import { loadSettings, type PiMrcSettings } from "../core/settings";
import { compactWithModelReference } from "../strategies/model-reference";
import { isPiMrcDisabled } from "../commands/pi-mrc-control";
import {
  formatCompactionReportMessageContent,
  PI_MRC_COMPACTION_REPORT_TYPE,
  type PiMrcCompactionReport,
} from "../core/compaction-report";
import {
  buildCompactionMrcReferenceIndex,
  PI_MRC_ANCHOR_TYPE,
  PI_MRC_REFERENCES_TYPE,
  isMrcReferenceMessage,
} from "../core/mrc-reference-journal";
import type { PiMrcCompactionDetails } from "../details";

export const PI_MRC_COMPACT_INSTRUCTION = "__pi_mrc__";

export interface CompactionStats {
  summarized: number;
  kept: number;
  keptTokensEst: number;
}

let lastStats: CompactionStats | null = null;
let lastCompactWasPiMrc = false;
export const getLastCompactionStats = () => lastStats;

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const dbg = (settings: PiMrcSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  try { writeFileSync("/tmp/pi-mrc-debug.json", JSON.stringify(data, null, 2)); } catch {}
};

interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown; customType?: string; display?: boolean; details?: unknown; timestamp?: number };
}

const messageFromEntry = (entry: any): EntryWithMessage | undefined => {
  if (entry?.type === "message" && entry.message) {
    return { entry, message: entry.message };
  }
  if (entry?.type === "custom_message") {
    const includeCustom = entry.customType === PI_MRC_ANCHOR_TYPE
      || entry.customType === PI_MRC_REFERENCES_TYPE
      || entry.customType === PI_MRC_COMPACTION_REPORT_TYPE;
    if (!includeCustom) return undefined;
    return {
      entry,
      message: {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : undefined,
      },
    };
  }
  return undefined;
};

const isPiMrcReportMessage = (message: any): boolean =>
  message?.role === "custom" && message?.customType === PI_MRC_COMPACTION_REPORT_TYPE;

export type OwnCutCancelReason =
  | "no_live_messages"
  | "too_few_live_messages"
  | "no_user_message";

export type OwnCutResult =
  | { ok: true; messages: any[]; firstKeptEntryId: string; compactAll: boolean }
  | { ok: false; reason: OwnCutCancelReason };

export function buildOwnCut(branchEntries: any[]): OwnCutResult {
  let lastCompactionIdx = -1;
  let lastKeptId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      lastKeptId = branchEntries[i].firstKeptEntryId;
      break;
    }
  }

  const hasPriorCompaction = lastCompactionIdx >= 0;
  const hasValidKeptId = !!lastKeptId && branchEntries.some((e: any) => e.id === lastKeptId);
  const orphanRecovery = hasPriorCompaction && !hasValidKeptId;

  const liveMessages: EntryWithMessage[] = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      const message = messageFromEntry(e);
      if (message) liveMessages.push(message);
    }
  } else {
    let foundKept = !lastKeptId;
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      const message = messageFromEntry(e);
      if (message) liveMessages.push(message);
    }
  }

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };

  let cutIdx = liveMessages.length - 1;
  while (cutIdx > 0 && liveMessages[cutIdx].message.role !== "user") {
    cutIdx--;
  }

  if (cutIdx <= 0) {
    const hasUser = liveMessages.some((m) => m.message.role === "user");
    if (!hasUser) return { ok: false, reason: "no_user_message" };
    return {
      ok: true,
      messages: liveMessages.map((e) => e.message),
      firstKeptEntryId: "",
      compactAll: true,
    };
  }

  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false,
  };
}

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "pi-mrc: Nothing to compact (no live messages)",
  too_few_live_messages: "pi-mrc: Too few messages to compact",
  no_user_message: "pi-mrc: Cannot compact — no user message found",
};

const makeMrcReport = (args: {
  summary: string;
  sourceMessageCount: number;
  keptMessageCount: number;
  keptTokensEst: number;
  skippedInternalMessageCount: number;
  tokensBefore: number;
  previousSummaryUsed: boolean;
  totalMs: number;
}): PiMrcCompactionReport => ({
  compactor: "pi-mrc",
  version: 1,
  sourceMessageCount: args.sourceMessageCount,
  keptMessageCount: args.keptMessageCount,
  keptTokensEst: args.keptTokensEst,
  skippedInternalMessageCount: args.skippedInternalMessageCount,
  tokensBefore: args.tokensBefore,
  summaryChars: args.summary.length,
  previousSummaryUsed: args.previousSummaryUsed,
  firstChangedLayer: args.previousSummaryUsed ? "Model-Ref Summary" : undefined,
  firstChangedPolicy: args.previousSummaryUsed ? "stable-current" : undefined,
  stableSectionCount: 1,
  stableUnchangedCount: 0,
  stableChangedSections: args.previousSummaryUsed ? ["Model-Ref Summary"] : [],
  recentSectionCount: 0,
  cappedSections: [],
  sections: [{
    name: "Model-Ref Summary",
    title: "Model-Ref Summary",
    role: "current",
    policy: "stable-current",
    status: "new",
    itemCount: 1,
    renderedItemCount: 1,
    chars: args.summary.length,
    reason: `MRC summary generated in ${args.totalMs.toFixed(1)}ms`,
    preview: [args.summary.replace(/\s+/g, " ").slice(0, 180)],
  }],
  warnings: [],
});

export const registerBeforeCompactHook = (pi: ExtensionAPI) => {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, customInstructions } = event;
    const settings = loadSettings();

    const isPiMrc = customInstructions === PI_MRC_COMPACT_INSTRUCTION;
    if (!isPiMrc && isPiMrcDisabled(ctx.sessionManager.getSessionFile())) return;
    if (!isPiMrc && !settings.overrideDefaultCompaction) return;

    const ownCut = buildOwnCut(branchEntries as any[]);
    if (!ownCut.ok) {
      dbg(settings, { cancelled: true, reason: ownCut.reason, isPiMrc });
      try { ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning"); } catch {}
      return { cancel: true };
    }

    const rawAgentMessages = ownCut.messages;
    const isInternalMessage = (message: any): boolean => isPiMrcReportMessage(message) || isMrcReferenceMessage(message);
    const skippedInternalMessageCount = rawAgentMessages.filter(isInternalMessage).length;
    const agentMessages = rawAgentMessages.filter((message: any) => !isInternalMessage(message));
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = convertToLlm(agentMessages);

    const keptIdx = (branchEntries as any[]).findIndex((e: any) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0
      ? (branchEntries as any[]).slice(keptIdx).filter((e: any) => e.type === "message")
      : [];
    const keptChars = keptEntries.reduce((sum: number, e: any) => {
      const c = e.message?.content;
      if (typeof c === "string") return sum + c.length;
      if (Array.isArray(c)) return sum + c.reduce((s: number, p: any) => {
        if (p.text) return s + p.text.length;
        if (p.type === "toolCall") return s + (p.name?.length ?? 0) + (typeof p.input === "string" ? p.input.length : JSON.stringify(p.input ?? "").length);
        if (p.type === "toolResult") return s + (typeof p.content === "string" ? p.content.length : JSON.stringify(p.content ?? "").length);
        return s;
      }, 0);
      return sum;
    }, 0);
    const keptTokensEst = Math.round(keptChars / 4);
    lastStats = {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptTokensEst,
    };

    const modelReferenceIndex = buildCompactionMrcReferenceIndex(branchEntries as any[], firstKeptEntryId);
    const mrcResult = await compactWithModelReference(messages, settings, {
      previousSummary: preparation.previousSummary,
    });
    const summary = mrcResult.summary;
    const report = makeMrcReport({
      summary,
      sourceMessageCount: agentMessages.length,
      keptMessageCount: keptEntries.length,
      keptTokensEst,
      skippedInternalMessageCount,
      tokensBefore: preparation.tokensBefore,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      totalMs: mrcResult.stats.totalMs,
    });

    dbg(settings, {
      strategy: "mrc",
      messagesToSummarize: agentMessages.length,
      firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      totalMs: mrcResult.stats.totalMs,
      stashedRefCount: modelReferenceIndex?.refs.length ?? 0,
    });

    const details: PiMrcCompactionDetails = {
      compactor: "pi-mrc",
      version: 3,
      sections: ["Model-Ref Summary"],
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      report,
      ...(modelReferenceIndex ? { modelReferenceIndex } : {}),
    };

    lastCompactWasPiMrc = isPiMrc;

    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details,
      },
    };
  });

  pi.on("session_compact", (event, ctx) => {
    if (!event.fromExtension) return;

    const details = (event.compactionEntry as any)?.details as PiMrcCompactionDetails | undefined;
    const report = details?.compactor === "pi-mrc" ? details.report : undefined;

    if (report) {
      try {
        pi.sendMessage({
          customType: PI_MRC_COMPACTION_REPORT_TYPE,
          content: formatCompactionReportMessageContent(report),
          display: true,
          details: report,
        }, { deliverAs: "nextTurn" });
      } catch {}
    }

    if (lastCompactWasPiMrc) return;
    const stats = lastStats;
    if (!stats) return;
    setTimeout(() => {
      try {
        ctx?.ui?.notify?.(
          `pi-mrc: ${stats.summarized} source entries processed; tail kept ${stats.kept} (~${formatTokens(stats.keptTokensEst)} tok).`,
          "info",
        );
      } catch {}
    }, 500);
  });
};
