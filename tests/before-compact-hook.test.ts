import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerBeforeCompactHook, PI_MRC_COMPACT_INSTRUCTION } from "../src/hooks/before-compact";
import { PI_MRC_COMPACTION_REPORT_TYPE } from "../src/core/compaction-report";
import { PI_MRC_ANCHOR_TYPE } from "../src/core/mrc-reference-journal";

let tmpDir: string;
let CONFIG_PATH: string;
const DEBUG_PATH = "/tmp/pi-mrc-debug.json";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-mrc-test-"));
  CONFIG_PATH = join(tmpDir, "pi-mrc-config.json");
  process.env.PI_MRC_CONFIG_PATH = CONFIG_PATH;
});

afterAll(() => {
  delete process.env.PI_MRC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function createMockPi() {
  let handler: ((event: any, ctx: any) => any) | undefined;
  let compactHandler: ((event: any, ctx: any) => any) | undefined;
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const sentMessages: Array<{ message: any; options: any }> = [];
  const ctx = {
    hasUI: true,
    sessionManager: {
      getSessionFile: () => join(tmpDir, "session.jsonl"),
    },
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
  };
  return {
    pi: {
      on: (eventName: string, h: (e: any, c: any) => any) => {
        if (eventName === "session_before_compact") handler = h;
        if (eventName === "session_compact") compactHandler = h;
      },
      sendMessage: (message: any, options: any) => {
        sentMessages.push({ message, options });
      },
    } as any,
    invoke: (event: any) => handler!(event, ctx),
    invokeCompact: (event: any) => compactHandler!(event, ctx),
    notifyCalls,
    sentMessages,
  };
}

function setConfig(cfg: Record<string, unknown>) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}

function makeEvent(branchEntries: any[], customInstructions?: string, preparation: Record<string, unknown> = {}) {
  return {
    type: "session_before_compact",
    customInstructions,
    branchEntries,
    preparation: {
      previousSummary: undefined,
      fileOps: { read: [], written: [], edited: [] },
      tokensBefore: 1000,
      firstKeptEntryId: "",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      ...preparation,
    },
    signal: new AbortController().signal,
  };
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const userAgent = (text = "x") => ({ role: "user", content: text, timestamp: Date.now() });
const assistantAgent = (text = "x") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "messages",
  provider: "test",
  model: "test",
  usage,
  stopReason: "stop",
  timestamp: Date.now(),
});
const toolAgent = (name = "read", text = "x") => ({
  role: "toolResult",
  toolCallId: "tc_1",
  toolName: name,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: Date.now(),
});
const customAgent = (customType: string, content = "x") => ({
  role: "custom",
  customType,
  content,
  timestamp: Date.now(),
});

const msg = (id: string, message: any = assistantAgent()) => ({ id, type: "message", message });
const comp = (id: string, firstKeptEntryId?: string, summary = "prior summary") => ({
  id,
  type: "compaction",
  firstKeptEntryId,
  summary,
});

describe("registerBeforeCompactHook", () => {
  beforeEach(() => {
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });

  test("/pi-mrc cancels when Pi preparation has no messages to summarize", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const result = await invoke(makeEvent([msg("m1", userAgent()), msg("m2", assistantAgent())], PI_MRC_COMPACT_INSTRUCTION));
    expect(result).toEqual({ cancel: true });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
    expect(notifyCalls[0].msg).toContain("Nothing to compact");
  });

  test("/compact with override=false short-circuits to Pi default compaction", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const result = await invoke(makeEvent([msg("m1", userAgent()), msg("m2", assistantAgent())], undefined));
    expect(result).toBeUndefined();
    expect(notifyCalls).toHaveLength(0);
  });

  test("uses Pi preparation and reports the Pi-selected kept boundary", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invoke, invokeCompact, notifyCalls, sentMessages } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("m1", userAgent("go")),
      msg("m2", assistantAgent("calling tool")),
      msg("m3", toolAgent("read", "result")),
      msg("m4", assistantAgent("kept tail")),
    ];
    const result = await invoke(makeEvent(entries, undefined, {
      firstKeptEntryId: "m4",
      messagesToSummarize: [userAgent("go"), assistantAgent("calling tool"), toolAgent("read", "result")],
    }));

    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("m4");
    expect(result.compaction.details.report).toMatchObject({
      compactor: "pi-mrc",
      sourceMessageCount: 3,
      keptMessageCount: 1,
      tokensBefore: 1000,
    });
    expect(notifyCalls).toHaveLength(0);

    invokeCompact({ fromExtension: true, compactionEntry: result.compaction });
    expect(sentMessages).toHaveLength(0);
  });

  test("does not queue next-turn report cards for repeated compactions", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invoke, invokeCompact, sentMessages } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [msg("m1", userAgent("go")), msg("m2", assistantAgent("summarized")), msg("m3", assistantAgent("tail"))];
    const result = await invoke(makeEvent(entries, undefined, {
      firstKeptEntryId: "m3",
      messagesToSummarize: [userAgent("go"), assistantAgent("summarized")],
    }));

    invokeCompact({ fromExtension: true, compactionEntry: result.compaction });
    invokeCompact({ fromExtension: true, compactionEntry: result.compaction });
    invokeCompact({ fromExtension: true, compactionEntry: result.compaction });

    expect(sentMessages).toHaveLength(0);
  });

  test("assistant/tool-only suffix after prior compaction does not cancel", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invoke, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u0", userAgent("original goal")),
      msg("a0", assistantAgent("older work")),
      comp("c1", "a1", "Previous summary with the user's goal."),
      msg("a1", assistantAgent("continued autonomously")),
      msg("t1", toolAgent("read", "large result")),
      msg("a2", assistantAgent("kept tail")),
    ];
    const result = await invoke(makeEvent(entries, undefined, {
      previousSummary: "Previous summary with the user's goal.",
      firstKeptEntryId: "a2",
      messagesToSummarize: [assistantAgent("continued autonomously"), toolAgent("read", "large result")],
    }));

    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("a2");
    expect(result.compaction.details.report).toMatchObject({
      compactor: "pi-mrc",
      sourceMessageCount: 2,
      keptMessageCount: 1,
      previousSummaryUsed: true,
    });
    expect(notifyCalls).toHaveLength(0);
  });

  test("filters internal MRC context messages from Pi preparation", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const result = await invoke(makeEvent([msg("m1"), msg("keep")], undefined, {
      firstKeptEntryId: "keep",
      messagesToSummarize: [
        assistantAgent("real content"),
        customAgent(PI_MRC_ANCHOR_TYPE, "[MRC anchors: ref:evidence:abc123]"),
        customAgent(PI_MRC_COMPACTION_REPORT_TYPE, "prior report"),
      ],
    }));

    expect(result.compaction.details.report).toMatchObject({
      sourceMessageCount: 1,
      skippedInternalMessageCount: 2,
    });
  });

  test("debug:true writes cancellation snapshot with no content leakage", async () => {
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("m1", assistantAgent("SECRET_TOKEN_abc123")),
      msg("m2", assistantAgent("sensitive response")),
    ];
    expect(await invoke(makeEvent(entries, PI_MRC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });

    expect(existsSync(DEBUG_PATH)).toBe(true);
    const snapshot = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    expect(snapshot.cancelled).toBe(true);
    expect(snapshot.reason).toBe("no_live_messages");
    expect(snapshot.isPiMrc).toBe(true);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("SECRET_TOKEN_abc123");
    expect(serialized).not.toContain("sensitive response");
  });

  test("debug:false does NOT write cancellation snapshot", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);
    expect(await invoke(makeEvent([msg("m1", userAgent()), msg("m2", assistantAgent())], PI_MRC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
    expect(existsSync(DEBUG_PATH)).toBe(false);
  });
});
