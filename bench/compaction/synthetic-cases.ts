import type { Message } from "@mariozechner/pi-ai";

export interface ExpectedTerm {
  label: string;
  term: string;
  /** Optional focused query for recall-style lookup. Defaults to the term. */
  query?: string;
}

export interface ScopedTerm extends ExpectedTerm {
  /** Enforce only after this term has appeared in the replayed source text. */
  afterTerm?: string;
}

export interface CompactionGold {
  /** Terms that should appear somewhere in the active prompt. */
  activeTerms: ExpectedTerm[];
  /** Terms that should appear in current-state layers, not only historical transcript/tail. */
  currentTerms?: ExpectedTerm[];
  /** Terms that should be recoverable from external recall. */
  recallTerms: ExpectedTerm[];
  /** Terms forbidden anywhere in the active prompt. */
  forbiddenTerms?: ScopedTerm[];
  /** Terms forbidden from current-state layers but allowed in historical layers or recall. */
  forbiddenCurrentTerms?: ScopedTerm[];
  /** Terms that must stay out of active prompt text because recall should carry them. */
  activeAbsentTerms?: ExpectedTerm[];
  continuationTerms?: ExpectedTerm[];
}

export interface CompactionBenchmarkCase {
  id: string;
  description: string;
  messages: Message[];
  /** Message counts at which to run a compaction cycle. */
  compactionPoints: number[];
  gold: CompactionGold;
}

const ts = 1_700_000_000_000;
let toolId = 0;

const assistantBase = {
  api: "messages" as any,
  provider: "anthropic" as any,
  model: "benchmark-fixture",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  timestamp: ts,
};

const user = (text: string): Message => ({ role: "user", content: text, timestamp: ts });

const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...assistantBase,
  stopReason: "stop",
});

const toolCall = (name: string, args: Record<string, unknown>): Message => {
  toolId += 1;
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: `bench_tool_${toolId}`, name, arguments: args }],
    ...assistantBase,
    stopReason: "toolUse",
  };
};

const toolResult = (name: string, text: string, isError = false): Message => ({
  role: "toolResult",
  toolCallId: `bench_tool_${toolId}`,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
  timestamp: ts,
});

const noisyLog = (needle: string): string => [
  ...Array.from({ length: 80 }, (_, i) => `debug ${String(i).padStart(2, "0")}: cache warmup shard ok`),
  `CRITICAL ${needle}`,
  ...Array.from({ length: 80 }, (_, i) => `debug ${String(i + 80).padStart(2, "0")}: retry window unchanged`),
].join("\n");

const longEvidencePayload = (needle: string): string => [
  ...Array.from({ length: 24 }, (_, i) => `/tmp/pi-vcc-cache-evidence/${needle}/very/deep/path/with/verbose/component/name/cache-proof-artifact-${String(i + 1).padStart(2, "0")}.json`),
  `CACHE_LONG_EVIDENCE request_id=${needle}`,
].join("\n");

const longScope = (tag: string): string =>
  `Also add detailed scope requirement ${tag} covering dashboard drift checks, benchmark explain output, report artifact review, rollback notes, and validation evidence before broader replay.`;

const longPreference = (tag: string): string =>
  `I prefer ${tag} notes to include dashboard drift checks, benchmark explain output, report artifact paths, rollback notes, and validation evidence before broader replay.`;

export const syntheticCompactionCases: CompactionBenchmarkCase[] = [
  {
    id: "boundary-loss-auth-refresh",
    description: "A critical constraint and error signature appear immediately before a compaction cut.",
    messages: [
      user("Fix password-reset login. Hard constraint: do not change the public login API."),
      assistant("I will inspect the auth refresh path and keep the public login API unchanged."),
      toolCall("read", { path: "src/auth/session.ts" }),
      toolResult("read", "export function refreshSessionAfterPasswordReset() { return null; }"),
      assistant("The likely fix belongs in src/auth/session.ts, not the public login handler."),
      toolCall("bash", { command: "bun test tests/auth-refresh.test.ts" }),
      toolResult("bash", "FAIL tests/auth-refresh.test.ts\nERR_REFRESH_AFTER_RESET expired refresh token after password reset", true),
      user("Continue from here. The next step is to patch refreshSessionAfterPasswordReset, then rerun tests/auth-refresh.test.ts."),
      assistant("I will patch refreshSessionAfterPasswordReset and rerun the focused auth-refresh test."),
    ],
    compactionPoints: [7, 9],
    gold: {
      activeTerms: [
        { label: "constraint", term: "do not change the public login API" },
        { label: "file", term: "src/auth/session.ts" },
        { label: "identifier", term: "ERR_REFRESH_AFTER_RESET" },
      ],
      currentTerms: [
        { label: "constraint", term: "do not change the public login API" },
        { label: "file", term: "src/auth/session.ts" },
        { label: "identifier", term: "ERR_REFRESH_AFTER_RESET" },
      ],
      recallTerms: [
        { label: "failing test", term: "tests/auth-refresh.test.ts", query: "auth-refresh" },
      ],
      continuationTerms: [
        { label: "next edit", term: "patch refreshSessionAfterPasswordReset" },
        { label: "next validation", term: "rerun tests/auth-refresh.test.ts" },
      ],
    },
  },
  {
    id: "identifier-provenance",
    description: "Similar identifiers make exact provenance and active entity recovery important.",
    messages: [
      user("Audit cache invalidation. The target artifact is /tmp/cache-probe-A17.log, not /tmp/cache-probe-A71.log."),
      assistant("I will keep the A17 artifact distinct from the A71 decoy and check the cache probe IDs."),
      toolCall("read", { path: "/tmp/cache-probe-A17.log" }),
      toolResult("read", "probe_id=cache_probe_A17\nspan=spn_cache_keep_91\ncommit=9f3a2b1\nstatus=prefix preserved"),
      toolCall("read", { path: "/tmp/cache-probe-A71.log" }),
      toolResult("read", "probe_id=cache_probe_A71\nspan=spn_cache_drop_19\nstatus=decoy"),
      assistant("Decision: use cache_probe_A17 and span spn_cache_keep_91 as the evidence handle. Ignore cache_probe_A71."),
      user("Continue the audit using commit 9f3a2b1 and evidence span spn_cache_keep_91."),
    ],
    compactionPoints: [6, 8],
    gold: {
      activeTerms: [
        { label: "artifact", term: "/tmp/cache-probe-A17.log" },
        { label: "probe", term: "cache_probe_A17" },
        { label: "span", term: "spn_cache_keep_91" },
        { label: "commit", term: "9f3a2b1" },
      ],
      currentTerms: [
        { label: "artifact", term: "/tmp/cache-probe-A17.log" },
        { label: "probe", term: "cache_probe_A17" },
        { label: "span", term: "spn_cache_keep_91" },
        { label: "commit", term: "9f3a2b1" },
      ],
      recallTerms: [
        { label: "decoy provenance", term: "cache_probe_A71", query: "cache_probe_A71" },
      ],
      forbiddenCurrentTerms: [
        { label: "decoy as current target", term: "use cache_probe_A71", afterTerm: "Ignore cache_probe_A71" },
      ],
      continuationTerms: [
        { label: "continue span", term: "spn_cache_keep_91" },
      ],
    },
  },
  {
    id: "recall-required-bulk-log",
    description: "A bulky log should be externalized while retaining a pointer and recallable exact failure line.",
    messages: [
      user("Investigate a flaky compaction benchmark. Store bulky logs as pointers when possible."),
      assistant("I will inspect the benchmark log and keep only the evidence handle in active state."),
      toolCall("bash", { command: "./run-benchmark > /tmp/pi-vcc-bench-482.log" }),
      toolResult("bash", noisyLog("CACHE_MISS_AT_LAYER_2B request_id=req_cache_482"), true),
      assistant("The important pointer is /tmp/pi-vcc-bench-482.log. The exact line CACHE_MISS_AT_LAYER_2B request_id=req_cache_482 can be recalled from the log."),
      user("Continue with the pointer only; do not paste the whole log back into context."),
    ],
    compactionPoints: [4, 6],
    gold: {
      activeTerms: [
        { label: "log pointer", term: "/tmp/pi-vcc-bench-482.log" },
      ],
      currentTerms: [
        { label: "log pointer", term: "/tmp/pi-vcc-bench-482.log" },
      ],
      recallTerms: [
        { label: "critical line", term: "CACHE_MISS_AT_LAYER_2B request_id=req_cache_482", query: "CACHE_MISS_AT_LAYER_2B req_cache_482" },
      ],
      activeAbsentTerms: [
        { label: "early bulky log line", term: "debug 00: cache warmup shard ok" },
        { label: "late bulky log line", term: "debug 120: retry window unchanged" },
      ],
      continuationTerms: [
        { label: "pointer discipline", term: "do not paste the whole log" },
      ],
    },
  },
  {
    id: "correction-stale-memory",
    description: "A corrected user preference should replace stale durable memory.",
    messages: [
      user("For this repo, prefer yarn test when validating."),
      assistant("Noted: yarn test for validation."),
      toolCall("bash", { command: "yarn test" }),
      toolResult("bash", "yarn: command not found", true),
      user("Correction: never use yarn here. Use npm test for broad validation and node --test for focused checks."),
      assistant("Understood. I will avoid yarn and use npm test or node --test depending on scope."),
      user("Continue and choose the focused validation command first."),
    ],
    compactionPoints: [4, 7],
    gold: {
      activeTerms: [
        { label: "corrected preference", term: "never use yarn" },
        { label: "broad validation", term: "npm test" },
        { label: "focused validation", term: "node --test" },
      ],
      currentTerms: [
        { label: "corrected preference", term: "never use yarn" },
        { label: "broad validation", term: "npm test" },
        { label: "focused validation", term: "node --test" },
      ],
      recallTerms: [
        { label: "failed old tool", term: "yarn: command not found", query: "yarn command not found" },
      ],
      forbiddenCurrentTerms: [
        { label: "stale positive preference", term: "prefer yarn test", afterTerm: "Correction: never use yarn here" },
      ],
      continuationTerms: [
        { label: "focused command", term: "node --test" },
      ],
    },
  },
  {
    id: "realistic-scope-and-status",
    description: "A real-session-shaped scope extension should be captured, but follow-up status should stay volatile.",
    messages: [
      user("Build a local ClickHouse-based OpenTelemetry ingestion and query system."),
      assistant("I will start with local ClickHouse, ingestion, and query scaffolding."),
      user("Good, now lets add meta monitoring for the chart itself. This means metrics for our clickhouse instance and dashboards for grafana."),
      assistant("I will extend the current work with meta monitoring and Grafana dashboards."),
      user("Status update: meta monitoring wiring is started; next validate dashboard provisioning."),
      assistant("Next step: validate dashboard provisioning without changing the stable objective."),
    ],
    compactionPoints: [2, 4, 6],
    gold: {
      activeTerms: [
        { label: "original objective", term: "OpenTelemetry ingestion and query system" },
        { label: "scope extension", term: "meta monitoring" },
      ],
      currentTerms: [
        { label: "original objective", term: "OpenTelemetry ingestion and query system" },
        { label: "scope extension", term: "meta monitoring" },
      ],
      recallTerms: [
        { label: "dashboard validation", term: "dashboard provisioning", query: "dashboard provisioning" },
      ],
      continuationTerms: [
        { label: "volatile next step", term: "validate dashboard provisioning" },
      ],
    },
  },
  {
    id: "cache-bust-scope-growth",
    description: "Stable objective and evidence remain fixed while additive scope updates change across compactions.",
    messages: [
      user("Build cache-aware compaction. Stable objective: preserve cacheable prefix while keeping continuation state recoverable."),
      assistant("Stable checkpoint: preserve cacheable prefix; canonical file src/core/compaction-state.ts; validation in Docker."),
      user("Also add dashboard provisioning checks to the current scope."),
      assistant("I will include dashboard provisioning checks in the current scope without changing the stable objective."),
      user("Also add Grafana datasource validation to the current scope."),
      assistant("I will include Grafana datasource validation as the latest scope update."),
      user("Also add provider cache accounting notes to the current scope."),
      assistant("I will include provider cache accounting notes while preserving the stable objective."),
    ],
    compactionPoints: [4, 6, 8],
    gold: {
      activeTerms: [
        { label: "stable objective", term: "preserve cacheable prefix" },
        { label: "canonical file", term: "src/core/compaction-state.ts" },
        { label: "first scope", term: "dashboard provisioning checks" },
        { label: "latest scope", term: "provider cache accounting notes" },
      ],
      currentTerms: [
        { label: "stable objective", term: "preserve cacheable prefix" },
        { label: "canonical file", term: "src/core/compaction-state.ts" },
        { label: "first scope", term: "dashboard provisioning checks" },
        { label: "latest scope", term: "provider cache accounting notes" },
      ],
      recallTerms: [
        { label: "middle scope", term: "Grafana datasource validation", query: "Grafana datasource validation" },
      ],
      continuationTerms: [
        { label: "latest scope", term: "provider cache accounting notes" },
      ],
    },
  },
  {
    id: "cache-bust-evidence-growth",
    description: "Stable work state remains unchanged while new evidence handles are discovered across compactions.",
    messages: [
      user("Audit cache probes. Stable objective: preserve prefix cache while tracking evidence handles. Always keep benchmark validation in Docker."),
      assistant("Stable checkpoint: preserve prefix cache; validation preference Docker; canonical file src/cache/probe.ts."),
      toolCall("read", { path: "src/cache/probe.ts" }),
      toolResult("read", "export const cacheProbe = 'cache_probe_alpha';\n// request_id=req_cache_alpha"),
      assistant("Evidence handles so far: src/cache/probe.ts and cache_probe_alpha."),
      toolCall("bash", { command: "grep -R cache_probe_beta /tmp/cache-evidence-beta.log" }),
      toolResult("bash", "CACHE_LAYER_SHIFT request_id=req_cache_beta\ntrace_id=trace_cache_beta\n/tmp/cache-evidence-beta.log"),
      assistant("Additional evidence handle: /tmp/cache-evidence-beta.log with req_cache_beta."),
      toolCall("bash", { command: "grep -R cache_probe_gamma /tmp/cache-evidence-gamma.log" }),
      toolResult("bash", "CACHE_LAYER_STABLE request_id=req_cache_gamma\ntrace_id=trace_cache_gamma\n/tmp/cache-evidence-gamma.log"),
      assistant("Additional evidence handle: /tmp/cache-evidence-gamma.log with req_cache_gamma."),
    ],
    compactionPoints: [5, 8, 11],
    gold: {
      activeTerms: [
        { label: "stable objective", term: "preserve prefix cache" },
        { label: "canonical file", term: "src/cache/probe.ts" },
        { label: "validation preference", term: "Docker" },
        { label: "latest evidence", term: "req_cache_gamma" },
      ],
      currentTerms: [
        { label: "stable objective", term: "preserve prefix cache" },
        { label: "canonical file", term: "src/cache/probe.ts" },
        { label: "validation preference", term: "Docker" },
        { label: "latest evidence", term: "req_cache_gamma" },
      ],
      recallTerms: [
        { label: "earlier beta evidence", term: "CACHE_LAYER_SHIFT request_id=req_cache_beta", query: "CACHE_LAYER_SHIFT req_cache_beta" },
      ],
      continuationTerms: [
        { label: "latest evidence", term: "req_cache_gamma" },
      ],
    },
  },
  {
    id: "cache-bust-mutable-tail-growth",
    description: "Recent scope, preference, and evidence updates should stay bounded while latest items remain recoverable.",
    messages: [
      user("Maintain cache-aware compaction. Stable objective: keep stable sections byte-stable while bounding recent mutable state."),
      assistant("Stable checkpoint: keep stable sections byte-stable; canonical file src/core/summarize.ts."),
      user("Also add scope item tail_scope_01 to the current scope. I prefer tail preference tail_pref_01."),
      toolCall("bash", { command: "grep req_tail_ev_01 /tmp/tail-evidence-01.log" }),
      toolResult("bash", "CACHE_TAIL_EVENT request_id=req_tail_ev_01 /tmp/tail-evidence-01.log"),
      assistant("Recorded tail_scope_01, tail_pref_01, and req_tail_ev_01."),
      user("Also add scope item tail_scope_02 to the current scope. I prefer tail preference tail_pref_02."),
      toolCall("bash", { command: "grep req_tail_ev_02 /tmp/tail-evidence-02.log" }),
      toolResult("bash", "CACHE_TAIL_EVENT request_id=req_tail_ev_02 /tmp/tail-evidence-02.log"),
      assistant("Recorded tail_scope_02, tail_pref_02, and req_tail_ev_02."),
      user("Also add scope item tail_scope_03 to the current scope. I prefer tail preference tail_pref_03."),
      toolCall("bash", { command: "grep req_tail_ev_03 /tmp/tail-evidence-03.log" }),
      toolResult("bash", "CACHE_TAIL_EVENT request_id=req_tail_ev_03 /tmp/tail-evidence-03.log"),
      assistant("Recorded tail_scope_03, tail_pref_03, and req_tail_ev_03."),
      user("Also add scope item tail_scope_04 to the current scope. I prefer tail preference tail_pref_04."),
      toolCall("bash", { command: "grep req_tail_ev_04 /tmp/tail-evidence-04.log" }),
      toolResult("bash", "CACHE_TAIL_EVENT request_id=req_tail_ev_04 /tmp/tail-evidence-04.log"),
      assistant("Recorded tail_scope_04, tail_pref_04, and req_tail_ev_04."),
      user("Also add scope item tail_scope_05 to the current scope. I prefer tail preference tail_pref_05."),
      toolCall("bash", { command: "grep req_tail_ev_05 /tmp/tail-evidence-05.log" }),
      toolResult("bash", "CACHE_TAIL_EVENT request_id=req_tail_ev_05 /tmp/tail-evidence-05.log"),
      assistant("Recorded tail_scope_05, tail_pref_05, and req_tail_ev_05."),
      user("Also add scope item tail_scope_06 to the current scope. I prefer tail preference tail_pref_06."),
      toolCall("bash", { command: "grep req_tail_ev_06 /tmp/tail-evidence-06.log" }),
      toolResult("bash", "CACHE_TAIL_EVENT request_id=req_tail_ev_06 /tmp/tail-evidence-06.log"),
      assistant("Recorded tail_scope_06, tail_pref_06, and req_tail_ev_06."),
      user("Also add scope item tail_scope_07 to the current scope. I prefer tail preference tail_pref_07."),
      toolCall("bash", { command: "grep req_tail_ev_07 /tmp/tail-evidence-07.log" }),
      toolResult("bash", "CACHE_TAIL_EVENT request_id=req_tail_ev_07 /tmp/tail-evidence-07.log"),
      assistant("Recorded tail_scope_07, tail_pref_07, and req_tail_ev_07."),
      user("Also add scope item tail_scope_08 to the current scope. I prefer tail preference tail_pref_08."),
      toolCall("bash", { command: "grep req_tail_ev_08 /tmp/tail-evidence-08.log" }),
      toolResult("bash", "CACHE_TAIL_EVENT request_id=req_tail_ev_08 /tmp/tail-evidence-08.log"),
      assistant("Recorded tail_scope_08, tail_pref_08, and req_tail_ev_08."),
    ],
    compactionPoints: [10, 22, 34],
    gold: {
      activeTerms: [
        { label: "stable objective", term: "keep stable sections byte-stable" },
        { label: "latest scope", term: "tail_scope_08" },
        { label: "latest preference", term: "tail_pref_08" },
        { label: "latest evidence", term: "req_tail_ev_08" },
      ],
      currentTerms: [
        { label: "stable objective", term: "keep stable sections byte-stable" },
        { label: "latest scope", term: "tail_scope_08" },
        { label: "latest preference", term: "tail_pref_08" },
        { label: "latest evidence", term: "req_tail_ev_08" },
      ],
      recallTerms: [
        { label: "old scope", term: "tail_scope_01", query: "tail_scope_01" },
        { label: "old evidence", term: "req_tail_ev_01", query: "req_tail_ev_01" },
      ],
      continuationTerms: [
        { label: "latest scope", term: "tail_scope_08" },
      ],
    },
  },
  {
    id: "cache-bust-commit-growth",
    description: "New git commits should not rewrite the stable commit section across repeated compactions.",
    messages: [
      user("Maintain cache-aware compaction. Stable objective: keep commit evidence visible without busting the stable prompt prefix."),
      assistant("Stable checkpoint: objective keep commit evidence visible; canonical file src/extract/commits.ts."),
      toolCall("bash", { command: "git commit -m \"test: add cache churn probe\"" }),
      toolResult("bash", "[feat/cache a1b2c3d] test: add cache churn probe\n 2 files changed"),
      assistant("Commit a1b2c3d recorded for the cache churn probe."),
      toolCall("bash", { command: "git commit -m \"fix: keep commit section stable\"" }),
      toolResult("bash", "[feat/cache b2c3d4e] fix: keep commit section stable\n 3 files changed"),
      assistant("Commit b2c3d4e recorded while preserving the stable objective."),
      toolCall("bash", { command: "git commit -m \"docs: explain commit cache boundary\"" }),
      toolResult("bash", "[feat/cache c3d4e5f] docs: explain commit cache boundary\n 1 file changed"),
      assistant("Commit c3d4e5f recorded; next compare commit cache boundary metrics."),
    ],
    compactionPoints: [5, 8, 11],
    gold: {
      activeTerms: [
        { label: "stable objective", term: "keep commit evidence visible" },
        { label: "canonical file", term: "src/extract/commits.ts" },
        { label: "latest commit", term: "c3d4e5f" },
      ],
      currentTerms: [
        { label: "stable objective", term: "keep commit evidence visible" },
        { label: "canonical file", term: "src/extract/commits.ts" },
        { label: "latest commit", term: "c3d4e5f" },
      ],
      recallTerms: [
        { label: "middle commit", term: "b2c3d4e", query: "b2c3d4e commit section stable" },
      ],
      continuationTerms: [
        { label: "next proof", term: "compare commit cache boundary metrics" },
      ],
    },
  },
  {
    id: "cache-bust-long-evidence-line",
    description: "A single fresh evidence line with many long paths should be clipped, not allowed to bloat the recent evidence layer.",
    messages: [
      user("Audit evidence formatting. Stable objective: keep evidence useful while bounding recent evidence line length."),
      assistant("Stable checkpoint: evidence must stay useful and bounded; canonical file src/extract/evidence.ts."),
      toolCall("bash", { command: "grep req_long_ev_anchor /tmp/pi-vcc-cache-evidence/anchor.log" }),
      toolResult("bash", "CACHE_LONG_EVIDENCE request_id=req_long_ev_anchor /tmp/pi-vcc-cache-evidence/anchor.log"),
      assistant("Initial evidence handle req_long_ev_anchor is recorded."),
      toolCall("bash", { command: "find /tmp/pi-vcc-cache-evidence/req_long_ev_latest -type f" }),
      toolResult("bash", longEvidencePayload("req_long_ev_latest")),
      assistant("Latest evidence handle req_long_ev_latest is recorded; keep the long path list bounded."),
    ],
    compactionPoints: [5, 8],
    gold: {
      activeTerms: [
        { label: "stable objective", term: "bounding recent evidence line length" },
        { label: "canonical file", term: "src/extract/evidence.ts" },
        { label: "latest evidence", term: "req_long_ev_latest" },
      ],
      currentTerms: [
        { label: "stable objective", term: "bounding recent evidence line length" },
        { label: "canonical file", term: "src/extract/evidence.ts" },
        { label: "latest evidence", term: "req_long_ev_latest" },
      ],
      recallTerms: [
        { label: "long path payload", term: "cache-proof-artifact-24.json", query: "cache-proof-artifact-24" },
      ],
      continuationTerms: [
        { label: "bounded path list", term: "long path list bounded" },
      ],
    },
  },
  {
    id: "cache-bust-long-scope-line",
    description: "Verbose fresh scope updates should stay bounded in the recent scope layer.",
    messages: [
      user("Maintain cache-aware compaction. Stable objective: keep verbose scope updates useful but bounded."),
      assistant("Stable checkpoint: objective keep verbose scope useful but bounded; canonical file src/extract/goals.ts."),
      user("Also add compact scope baseline to the current scope."),
      assistant("Baseline current scope is established."),
      user([longScope("scope_long_alpha"), longScope("scope_long_beta"), longScope("scope_long_gamma")].join("\n")),
      assistant("Recorded verbose scope updates; next verify the recent scope layer remains bounded."),
    ],
    compactionPoints: [4, 6],
    gold: {
      activeTerms: [
        { label: "stable objective", term: "verbose scope updates useful but bounded" },
        { label: "canonical file", term: "src/extract/goals.ts" },
        { label: "latest scope", term: "scope_long_beta" },
      ],
      currentTerms: [
        { label: "stable objective", term: "verbose scope updates useful but bounded" },
        { label: "canonical file", term: "src/extract/goals.ts" },
        { label: "latest scope", term: "scope_long_beta" },
      ],
      recallTerms: [
        { label: "third verbose scope", term: "scope_long_gamma", query: "scope_long_gamma" },
      ],
      continuationTerms: [
        { label: "bounded recent scope", term: "recent scope layer remains bounded" },
      ],
    },
  },
  {
    id: "cache-bust-long-preference-line",
    description: "Verbose fresh preferences should stay bounded in the recent preferences layer.",
    messages: [
      user("Maintain cache-aware compaction. Stable objective: keep verbose preferences useful but bounded.\nAlways use Docker for broad validation."),
      assistant("Stable checkpoint: objective keep verbose preferences useful but bounded; canonical file src/extract/preferences.ts."),
      user(longPreference("pref_long_alpha")),
      assistant("Recorded pref_long_alpha."),
      user(longPreference("pref_long_beta")),
      assistant("Recorded pref_long_beta."),
      user(longPreference("pref_long_gamma")),
      assistant("Recorded pref_long_gamma; next verify the recent preference layer remains bounded."),
    ],
    compactionPoints: [2, 8],
    gold: {
      activeTerms: [
        { label: "stable objective", term: "verbose preferences useful but bounded" },
        { label: "canonical file", term: "src/extract/preferences.ts" },
        { label: "latest preference", term: "pref_long_gamma" },
      ],
      currentTerms: [
        { label: "stable objective", term: "verbose preferences useful but bounded" },
        { label: "canonical file", term: "src/extract/preferences.ts" },
        { label: "latest preference", term: "pref_long_gamma" },
      ],
      recallTerms: [
        { label: "first verbose preference", term: "pref_long_alpha", query: "pref_long_alpha" },
      ],
      continuationTerms: [
        { label: "bounded recent preference", term: "recent preference layer remains bounded" },
      ],
    },
  },
  {
    id: "model-ref-keep-ref-drop",
    description: "Model classifies conversation into KEEP (critical identifiers), REF (useful context), and DROP (fluff). Subsequent compactions merge with previous classifications.",
    messages: [
      user("Work on src/core/session.ts. The session module needs cache-aware state tracking."),
      assistant("Working on src/core/session.ts. CACHE_SESSION probe request_id=sess-001. Added state tracking with commit abc1234."),
      user("Also, what should I have for lunch? Thinking tacos or sushi."),
      assistant("Tacos would be a great choice. There's a place nearby."),
      user("OK back to work. Always use Docker for validation. Now continue on src/core/session.ts."),
      assistant("Continuing on src/core/session.ts. Respecting Docker preference. Added validation config."),
    ],
    compactionPoints: [2, 6],
    gold: {
      activeTerms: [
        { label: "file path", term: "src/core/session.ts" },
        { label: "error signature", term: "CACHE_SESSION" },
        { label: "request id", term: "request_id" },
        { label: "commit hash", term: "abc1234" },
        { label: "preference", term: "always use Docker" },
      ],
      currentTerms: [
        { label: "file path", term: "src/core/session.ts" },
        { label: "error signature", term: "CACHE_SESSION" },
        { label: "request id", term: "request_id" },
        { label: "commit hash", term: "abc1234" },
        { label: "preference", term: "always use Docker" },
      ],
      recallTerms: [
        { label: "lunch discussion", term: "lunch", query: "lunch tacos" },
      ],
      continuationTerms: [
        { label: "docker preference respected", term: "Docker" },
      ],
    },
  },
  {
    id: "multi-cycle-ref-promotion",
    description: "Auth chunks become REF during database phase, promoted back when auth returns. Tests merge-awareness across 3 compactions.",
    messages: [
      user("Work on auth module. Implement JWT refresh token rotation in src/auth/refresh.ts."),
      assistant("Auth module: added token rotation to src/auth/refresh.ts, commit a1b2c3d. ERR_AUTH_REFRESH request_id=req-auth-001."),
      user("Switch to database module. Add connection pooling to src/db/pool.ts. Always use PostgreSQL."),
      assistant("DB module: added connection pooling to src/db/pool.ts, commit d4e5f6g. CACHE_DB_POOL request_id=req-db-001."),
      user("Back to auth module. The refresh token rotation from earlier needs audit logging."),
      assistant("Auth module: adding audit logging to src/auth/refresh.ts per earlier JWT rotation, commit a7b8c9d."),
    ],
    compactionPoints: [2, 4, 6],
    gold: {
      // No strict activeTerms on topics — the classifier correctly demotes non-current
      // topics to REF. This IS the multi-cycle promotion behavior we're testing.
      currentTerms: [
        { label: "auth file tracked", term: "src/auth/refresh.ts" },
        { label: "db file tracked", term: "src/db/pool.ts" },
      ],
      recallTerms: [
        { label: "JWT detail", term: "JWT refresh", query: "JWT refresh token" },
        { label: "DB pooling", term: "connection pooling", query: "PostgreSQL pooling" },
      ],
      continuationTerms: [
        { label: "audit logging", term: "audit logging" },
      ],
    },
  },
  {
    id: "cache-bust-volatile-next-step",
    description: "Stable objective and identifiers remain fixed while only volatile next-step state changes across cycles.",
    messages: [
      user("Benchmark cache-aware compaction. Stable objective: preserve Layer 0 and Layer 1 prefixes."),
      assistant("Stable checkpoint: objective preserve Layer 0 and Layer 1 prefixes; identifier cache_schema_v3."),
      user("Current blocker: first run lacks cached input token accounting."),
      assistant("Next step: add offline LCP token metrics for cache_schema_v3."),
      user("Blocker update: offline LCP metrics are done; now add recall top-k metrics."),
      assistant("Next step: add recall top-k metrics while preserving cache_schema_v3 stable text."),
      user("Blocker update: recall top-k metrics are done; now document live provider limits."),
      assistant("Next step: document live provider limits without changing Layer 0 or Layer 1 wording."),
    ],
    compactionPoints: [4, 6, 8],
    gold: {
      activeTerms: [
        { label: "stable objective", term: "preserve Layer 0 and Layer 1 prefixes" },
        { label: "schema", term: "cache_schema_v3" },
      ],
      currentTerms: [
        { label: "stable objective", term: "preserve Layer 0 and Layer 1 prefixes" },
        { label: "schema", term: "cache_schema_v3" },
      ],
      recallTerms: [
        { label: "old blocker", term: "first run lacks cached input token accounting", query: "cached input token accounting" },
      ],
      continuationTerms: [
        { label: "latest next step", term: "document live provider limits" },
      ],
    },
  },
];
