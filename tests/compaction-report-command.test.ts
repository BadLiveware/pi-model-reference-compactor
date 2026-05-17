import { describe, expect, test } from "bun:test";
import { registerPiVccReportCommand } from "../src/commands/pi-vcc-report";
import type { PiVccCompactionReport } from "../src/core/compaction-report";
import { PI_VCC_REPORT_COMMAND_TYPE } from "../src/core/compaction-report-history";

const sampleReport = (): PiVccCompactionReport => ({
  compactor: "pi-vcc",
  version: 1,
  sourceMessageCount: 3,
  keptMessageCount: 1,
  keptTokensEst: 25,
  skippedInternalMessageCount: 0,
  tokensBefore: 300,
  summaryChars: 120,
  previousSummaryUsed: false,
  firstChangedLayer: "Pi VCC Session Goal",
  firstChangedPolicy: "stable-current",
  stableSectionCount: 1,
  stableUnchangedCount: 0,
  stableChangedSections: ["Session Goal"],
  recentSectionCount: 0,
  cappedSections: [],
  warnings: [],
  sections: [{
    name: "Pi VCC Session Goal",
    title: "Session Goal",
    role: "current",
    policy: "stable-current",
    status: "new",
    itemCount: 1,
    renderedItemCount: 1,
    chars: 42,
    reason: "stable",
    preview: ["Build report inspection"],
  }],
});

const createMockPi = (entries: any[]) => {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const sentMessages: any[] = [];
  const notifications: any[] = [];
  const pi = {
    registerCommand: (_name: string, options: any) => { handler = options.handler; },
    sendMessage: (message: any, options?: any) => sentMessages.push({ message, options }),
  } as any;
  const ctx = {
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => undefined,
    },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  };
  registerPiVccReportCommand(pi);
  return {
    run: (args: string) => handler!(args, ctx),
    sentMessages,
    notifications,
  };
};

describe("pi-vcc-report command", () => {
  test("writes artifact summary for latest report by default", async () => {
    const report = sampleReport();
    const mock = createMockPi([
      { id: "c1", type: "compaction", timestamp: "t1", details: { compactor: "pi-vcc", version: 2, report } },
    ]);

    await mock.run("");

    expect(mock.sentMessages).toHaveLength(1);
    expect(mock.sentMessages[0].message.customType).toBe(PI_VCC_REPORT_COMMAND_TYPE);
    expect(mock.sentMessages[0].message.content).toContain("Deep dive artifacts");
    expect(mock.sentMessages[0].message.details.report).toBe(report);
  });

  test("shows inline report or warning when requested report is missing", async () => {
    const report = sampleReport();
    const mock = createMockPi([
      { id: "c1", type: "compaction", timestamp: "t1", details: { compactor: "pi-vcc", version: 2, report } },
    ]);

    await mock.run("show entry:c1");
    await mock.run("entry:missing");

    expect(mock.sentMessages[0].message.content).toContain("Sanity check");
    expect(mock.notifications).toEqual([{ message: "No pi-vcc compaction report found for entry missing.", level: "warning" }]);
  });
});
