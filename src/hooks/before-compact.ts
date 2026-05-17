import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { writeFileSync } from "fs";
import { loadSettings, type PiMrcSettings } from "../core/settings";
import { compactWithModelReference } from "../strategies/model-reference";
import { isPiMrcDisabled } from "../commands/pi-mrc-control";
import {
  PI_MRC_COMPACTION_REPORT_TYPE,
  type PiMrcCompactionReport,
} from "../core/compaction-report";
import {
  buildCompactionMrcReferenceIndex,
  isMrcAnchorMessage,
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

const isPiMrcReportMessage = (message: any): boolean =>
  message?.role === "custom" && message?.customType === PI_MRC_COMPACTION_REPORT_TYPE;

type PreparationCancelReason = "no_live_messages";

const REASON_MESSAGES: Record<PreparationCancelReason, string> = {
  no_live_messages: "pi-mrc: Nothing to compact (no live messages)",
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

    const rawAgentMessages = [
      ...(Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : []),
      ...(Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages : []),
    ];
    if (rawAgentMessages.length === 0) {
      const reason: PreparationCancelReason = "no_live_messages";
      dbg(settings, { cancelled: true, reason, isPiMrc });
      try { ctx?.ui?.notify?.(REASON_MESSAGES[reason], "warning"); } catch {}
      return { cancel: true };
    }

    const isInternalMessage = (message: any): boolean =>
      isPiMrcReportMessage(message) || isMrcReferenceMessage(message) || isMrcAnchorMessage(message);
    const skippedInternalMessageCount = rawAgentMessages.filter(isInternalMessage).length;
    const agentMessages = rawAgentMessages.filter((message: any) => !isInternalMessage(message));
    const firstKeptEntryId = typeof preparation.firstKeptEntryId === "string"
      ? preparation.firstKeptEntryId
      : "";
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

    // Do not enqueue report cards as next-turn custom messages. Multiple
    // compactions can happen before the next user prompt, and Pi flushes every
    // pending nextTurn message into that prompt, producing duplicate cards and
    // extra LLM context. The report remains persisted in compaction.details and
    // is available through /pi-mrc-report.
    if (lastCompactWasPiMrc) return;
    const stats = lastStats ?? (report ? {
      summarized: report.sourceMessageCount,
      kept: report.keptMessageCount,
      keptTokensEst: report.keptTokensEst,
    } : null);
    if (!stats) return;
    setTimeout(() => {
      try {
        ctx?.ui?.notify?.(
          `pi-mrc: ${stats.summarized} source entries processed; tail kept ${stats.kept} (~${formatTokens(stats.keptTokensEst)} tok). Use /pi-mrc-report for details.`,
          "info",
        );
      } catch {}
    }, 500);
  });
};
