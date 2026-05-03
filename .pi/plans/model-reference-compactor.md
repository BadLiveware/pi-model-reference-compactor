# Model-Reference Compactor Plan

## Objective
Design a compaction strategy where a model classifies conversation chunks into three tiers (KEEP, REF, DROP) without writing rewritten content, and an algorithmic stitcher orders the kept chunks for maximum cache prefix stability. Combine model classification cheapness with algorithmic cache optimization.

## Why this plan exists
Every current compaction system either:
- has the model **write** the summary (hallucination risk, expensive output tokens, cache-churning rewrites)
- uses purely algorithmic heuristics (misses semantic importance, brittle rules)

This plan explores a third path: the model only **classifies**, writing only minimal structured output (IDs + one-liners + a short MVS paragraph). The algorithmic side stitches, orders for cache stability, and manages the Tier 2 retrievable index.

## Core insight
The model's output for a classification task is ~10× cheaper (in tokens) than for a summary-generation task. And since the model processes the same conversation context (which is almost entirely cache-hit), the additional latency is proportional only to the tiny output.

## Core design

### Three tiers

```
┌──────────────────────────────────────────────────┐
│ Tier 1: ACTIVE PROMPT (always in context)        │
│                                                    │
│  [MVS] Minimum Viable Summary - model writes     │
│  Working on cache compaction. Added probes...    │
│                                                    │
│  [Critical References] - KEEP chunks             │
│  C12: src/core/compaction-state.ts (file)        │
│  C17: f36b837 fix: bound verbose recent...       │
│  C42: CACHE_LONG_SCOPE request_id=scope_alpha    │
├──────────────────────────────────────────────────┤
│ Tier 2: RETRIEVABLE INDEX (file/DB, pullable)    │
│                                                    │
│  C3:  "discussed auth token refresh pattern"     │
│  C8:  "explored benchmark framework options"     │
│  C22: "identified perf bottleneck in state.ts"   │
├──────────────────────────────────────────────────┤
│ Tier 3: RAW ARCHIVE (session JSONL, vcc_recall)  │
│                                                    │
│  Everything. Dropped chunks still here.          │
│  Searchable but not in context.                  │
└──────────────────────────────────────────────────┘
```

### What the model outputs per compaction

```
KEEP: C12, C15, C17, C42
REF: C3 "discussed auth token refresh"
REF: C8 "benchmark framework design options"
REF: C22 "perf bottleneck in compaction-state"
DROP: C1, C2, C4, C5, C6, C7, C9, C10, C11
MVS: Working on cache compaction. Added cache-boundary
     probes for commit growth and long evidence lines.
     Real-session comparison shows +113 stable prefix
     tokens vs baseline 53dc551. Next: investigate
     remaining Commits churn outliers.
```

Total output: ~200-500 tokens. Compare to Anthropic compaction: ~2,000-5,000 tokens.

### What the algorithm does

1. **Chunk** — split fresh messages into referenceable units, each with a stable ID.
2. **Send** — current context (cache-hit) + chunk inventory to the model.
3. **Receive** — model returns KEEP/REF/DROP classification with one-liners + MVS.
4. **Order** — arrange KEEP chunks to maximize cache-prefix stability (context ordering algorithm).
5. **Stitch** — assemble Tier 1 prompt: MVS + ordered KEEP chunks + recent raw tail.
6. **Index** — write/update Tier 2 REF index: chunk ID → one-line summary.
7. **Drop** — dropped chunks go to Tier 3 raw archive only.

### Chunk model

Each chunk has:
- **Stable ID** — survives across compactions (e.g., `msg:42`, `evidence:3`, `transcript:17`).
- **Type** — section item, transcript line, tool result, user message, assistant message, etc.
- **Content** — the full text, kept verbatim when in KEEP tier.
- **Metadata** — timestamp, role, tool name if applicable.

Chunks are extracted from the same `NormalizedBlock[]` that `compileWithReport(...)` already consumes.

### Ordering algorithm

The goal: maximize stable prefix length across compactions.

1. **Dependency graph** — some chunks reference each other (e.g., a tool result references a tool call). Preserve reference order.
2. **Stability score** — chunks that have been in KEEP tier across multiple compactions get higher stability weight. Position them earlier.
3. **Type ordering** — goal-like chunks before file-path chunks before transcript chunks.
4. **Deterministic tiebreak** — sorting by stability score, then by type priority, then by stable ID.

Algorithm sketch:
```
function orderKeepChunks(chunks, previousKEEP, dependencyEdges):
    # Topological sort respecting dependencies
    # Weighted by stability score (times in previous KEEP / total compactions)
    # Type priority: goal > constraint > decision > file > commit > evidence > transcript
    # Final tiebreak: stable ID lexicographic
```

### Retrieval loop

On the **next** compaction, the model also sees the Tier 2 REF index and can promote chunks:

```
# Current Tier 2 index shown to model:
# C3:  "discussed auth token refresh pattern"
# C8:  "explored benchmark framework options"

# Model output:
KEEP: C8, C12, C42    ← C8 promoted back because conversation returned to benchmarking
REF: C15 "added probes for commit growth"   ← C15 demoted
DROP: C3, C17, C22
MVS: Still working on cache compaction. Conversation shifted back
     to benchmark framework architecture...
```

### Cost architecture

| | Anthropic compaction | Model-reference compactor | Ratio |
|---|---|---|---|
| Model call | Yes (separate sampling step) | Yes | Same count |
| Input tokens | Full conversation (cache-read) | Full conversation (cache-read) | Same |
| Output tokens | ~3,000 (prose summary) | ~400 (IDs + one-liners + MVS) | **7.5× less** |
| Cache-write penalty | 3,000 new tokens to cache | ~200 new tokens (MVS only) | **15× less** |
| Next-turn cache stability | Summary changes every compaction | KEEP chunks ordered for stability | **Much better** |

### Why this avoids hallucination better

| Content type | Who creates it | Hallucination risk |
|---|---|---|
| File paths | Algorithm extracts, model only selects | None (model picks from real paths) |
| Commit hashes | Algorithm extracts, model only selects | None |
| Error signatures | Algorithm extracts, model only selects | None |
| Preference text | Algorithm extracts, model only selects | None |
| MVS paragraph | Model writes free text | Low (short, bounded, reviewable) |
| REF one-liners | Model writes one sentence per chunk | Low (short, anchored to known chunk) |

### Actionable REF summaries

REF entries should tell the agent **when** to retrieve, not just **what** is stored. Instead of passive descriptions:

```
REF: D8 "candidate decision reporting preference"
```

Write recall conditions:

```
REF: D8 "Recall if revisiting how physical decisions are captured in benchmark output"
REF: join-shapes-bundle "Recall if returning to workload-virtual-rule-optimizations (Phase 3: join enrichment)"
REF: recording-rules-bundle "Recall if user asks about MV/RMV tradeoffs or static analysis for recording rules"
```

The classifier prompt includes this rule:

```
For each REF chunk or bundle, write a one-line summary that tells
the agent WHEN to recall it: "Recall if <trigger condition>"
```

### Goal-bundle parking

When conversation shifts to a new goal, the old goal's context shouldn't be dropped — it should be **parked** as a retrievable bundle with revival instructions.

```
Session has 4 goals over its lifetime:

┌─────────────────────────────────────────────────────┐
│ ACTIVE PROMPT (Tier 1)                              │
│                                                     │
│  MVS: Working on recording rule MV optimization    │
│  KEEP: files, decisions, evidence for THIS goal    │
├─────────────────────────────────────────────────────┤
│ RETRIEVABLE GOAL BUNDLES (Tier 2)                   │
│                                                     │
│  [goal:broad-sweep]                                 │
│  PR #14, native range chunking, benchmark profiling │
│  "Recall if user asks about range query performance │
│   or PR #14 benchmark results"                      │
│  Files: internal/promshim/native/range_*.go         │
│  Decisions: chunking bounds, operator caps          │
│                                                     │
│  [goal:join-enrichment]                             │
│  Phase 3 metadata-enrichment join shapes            │
│  "Recall if user returns to workload-virtual-rule-  │
│   optimizations or PromQL semantic preservation"    │
│  Files: internal/promshim/local/planner_*.go        │
│  Decisions: strict PromQL semantics, lowerer contracts│
│                                                     │
│  [goal:bootstrap-stabilization]                     │
│  Chart-only Helm bootstrap, CRD sequencing          │
│  "Recall if user asks about deployment or CI"       │
│  Files: scripts/bootstrap-kind.sh, chart/...        │
│  Decisions: ArgoCD-style, namespace-aware            │
└─────────────────────────────────────────────────────┘
```

When the user says "actually, go back to join shapes," the model sees the bundle entry in the REF index, calls `vcc_recall` with the bundle ID, and recovers the full parked context.

Bundle model:

```typescript
interface GoalBundle {
  id: string;
  label: string;           // "join-enrichment"
  recallCondition: string; // "Recall if returning to workload-virtual-rule-optimizations"
  chunks: CompactionChunk[];  // all chunks parked with this goal
  status: "active" | "parked" | "completed";
  parkedAt: number;        // compaction cycle when parked
  promotionCount: number;  // times this bundle was revived
}
```

The classifier promotes goal bundles back to active when recent user messages trigger their recall conditions.

### Recent-user-message weighting

The classifier must **weigh the user's most recent explicit decisions above goals extracted from older compaction summaries.** A user saying "Alright, lets do it" about a topic IS the current goal — even if older summaries still reference previous work.

This prevents the stale-goal problem observed in real sessions where Pi's iterative summary merge preserved "Phase 3: join enrichment" as the goal 15 compactions after the conversation had moved on to recording rule MV optimization.

### Full MRC prompt budget

With all sections rendered (MVS + KEEP chunks + REF index + recall note), a realistic Tier 1 prompt:

| Section | Typical size |
|---|---|
| MVS paragraph | ~100-200 chars |
| KEEP chunks rendered | ~800-1,500 chars |
| REF index (actionable one-liners) | ~150-300 chars |
| Recall note | ~130 chars |
| **Total MRC summary** | **~1,200-2,100 chars (~300-525 tokens)** |

Plus system prompt, tool definitions, project instructions, and raw tail for a full prompt of ~1,500-2,000 tokens, versus Pi's 10,000-12,000 token equivalent.The model never invents paths, commits, or identifiers — it only picks from real ones.

---

## Implementation phases

### Phase 1: Benchmark scaffold
1. Add `src/core/chunk-model.ts` — chunk types, stable ID generation, extraction from NormalizedBlock[].
2. Add `bench/compaction/model-reference-selector.ts` — compactor entry that:
   - Chunks fresh messages.
   - Calls a mock model (heuristic: keep chunks containing known needles).
   - Orders KEEP chunks.
   - Stitches Tier 1 output.
   - Writes/reads Tier 2 index to a temp file or in-memory store.
3. Add synthetic benchmark cases that exercise:
   - KEEP vs REF vs DROP classification correctness.
   - Promotion/demotion across compactions.
   - Cache-prefix stability across repeated compactions.
   - Tier 2 retrieval (missing context rescued by REF index).
4. Register `model-reference-selector` as a compactor in `bench/compaction/offline-runner.ts`.
5. Run head-to-head against `pi-vcc` on synthetic and real sessions.

### Phase 2: Real model integration
1. Design the model prompt for classification — minimal, structured, expects parseable output.
2. Build a real model call path (configurable provider, e.g., Anthropic Messages API).
3. Add output parsing that recovers KEEP/REF/DROP/MVS from model response.
4. Add error handling for malformed model output.
5. Add optional cost/latency tracking per compaction.
6. Compare real model results vs mock model results on synthetic benchmarks.
7. Test with cheaper model variants (Haiku, Flash) to find the cheapest sufficient classifier.

### Phase 3: Retrieval loop
1. Implement Tier 2 index read-before-compaction.
2. Model prompt includes REF index entries as candidate promotion targets.
3. Model can promote REF → KEEP or keep REF → REF or drop REF → DROP.
4. Algorithm rebuilds KEEP order after promotions.
5. Add benchmark case: context recovered after simulated memory loss.

### Phase 4: Cache ordering optimization
1. Implement the ordering algorithm proper:
   - Dependency-aware topological sort.
   - Stability-weighted positioning.
   - Type-priority ordering.
2. Add cache-stability assertions to benchmark:
   - `firstChangedPromptLayer` check.
   - `stablePrefixTokens` threshold.
   - `fullPromptLcpTokenRatioWithPrevious`.
3. Compare ordering quality against pure `pi-vcc` ordering.

### Phase 5: Live Pi integration (deferred)
1. Wire as a pi-vcc compactor variant behind a config flag.
2. Use real provider credentials.
3. Measure real cache-hit ratios via provider-reported usage.
4. Tune thresholds and ordering parameters on real sessions.
5. Add `/pi-vcc-report` integration for the model-reference compactor's reports.

---

## Evaluation

### Correctness
- Can the agent continue correctly after model-reference compaction?
- Does the MVS capture enough state for continuity?
- Can promoted REF chunks restore missing context?

### Cache stability
- `firstChangedPromptLayer` — which layer changes first across compactions?
- `stablePrefixTokens` — how many tokens before the first change?
- `fullPromptLcpTokenRatioWithPrevious` — how much of the prompt is cache-hit?

### Cost
- Output tokens per compaction.
- Cache-write tokens per compaction.
- Total input + output cost per compaction cycle.
- Comparison against pi-vcc (zero model cost) and Anthropic compaction (full model cost).

### Retrieval effectiveness
- Does the model promote REF chunks when conversation returns to a topic?
- Does the REF index actually help recovery vs having nothing?
- False positive/negative rates on REF → KEEP promotions.

### Comparison against pi-vcc
Run `scripts/compare-compaction-refs.mjs` with `--compactors pi-vcc,model-reference-selector` on:
- Synthetic benchmark cases.
- Real session replay (10-20 sessions, 3 cycles each).
- Cache-stability metrics.
- Correctness assertions.

---

## Risks

| Risk | Mitigation |
|---|---|
| Model output unparseable | Strict output format, fallback to pi-vcc on parse failure |
| Model too expensive for classification | Start with cheapest model (Haiku); mock model for benchmarking |
| Chunk granularity wrong | Benchmark multiple chunking strategies; start with section-item granularity |
| KEEP set too large (over-budget) | Algorithmic cap: keep top-N by stability score, overflow to REF |
| REF index grows unbounded | Cap by time or count; drop oldest/lowest-promotion-rate entries |
| Cache ordering breaks dependencies | Topological sort as first pass; only stability-weight within dependency groups |
| Provider availability | Mock model enables full benchmarking without provider dependency |

---

## Decision heuristics

### Favor model-reference over pure algorithmic when
- Semantic importance of content matters more than heuristics capture.
- Hallucination risk from model-written summaries is unacceptable.
- Cheap model API calls are available (Haiku, Flash, local).
- Cache-prefix stability is a primary cost concern.

### Favor pi-vcc (pure algorithmic) over model-reference when
- Cost or latency of any model call is unacceptable.
- Heuristic extraction is good enough for the domain.
- Provider is unavailable or unreliable.
- Real-time compaction latency must be near-zero.

### Favor Anthropic compaction over model-reference when
- Provider already offers compaction as a first-party feature.
- You trust the provider's summary quality.
- Integration simplicity matters more than cost optimization.

---

## Status
Benchmark scaffold built and committed. Real DeepSeek Flash classifier tested on a 14K-message production session (promshim-ch, 80 compactions). Key findings:

- Model-reference (DeepSeek Flash) produces a 1,958-char active prompt vs Pi's 41,659-char summary — **21× smaller**.
- Real classifier correctly identifies current goal (PR #14) while Pi's summary preserves a stale goal from 15 compactions ago.
- Cost: ~$0.001 per classification vs $0.18 for Pi's LLM summary — **180× cheaper**.
- Actionable REF summaries and goal-bundle parking designed but not yet implemented.
- Full prompt with system/tools/project/raw-tail: MRC ~1,789 tokens vs Pi ~11,714 tokens — **6.5× smaller**.

Next: implement actionable REF summaries, goal-bundle parking, and recent-user-message weighting in the classifier prompt. Then re-test on the same session.

## Sources
- `AGENTS.md` — pi-vcc project north star and design principles.
- `.pi/plans/cache-aware-compaction.md` — original cache-aware compaction plan.
- `bench/compaction/README.md` — existing benchmark harness design.
- Anthropic compaction docs — https://platform.claude.com/docs/en/build-with-claude/compaction
- Anthropic effective context engineering — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- AWS Bedrock AgentCore compaction — https://towardsai.net/p/machine-learning/long-context-compaction-for-ai-agents-part-2-implementation-and-evaluation
- ContextPilot (arxiv 2511.03475v3) — context reuse via block ordering and deduplication for KV-cache.
- MemGPT/Letta — tiered memory architecture with model-managed memory blocks.
- OpenCode compaction epic — https://github.com/sst/opencode/issues/4102
- Victor Dibia context engineering — https://newsletter.victordibia.com/p/context-engineering-101-how-agents
- `src/core/classifier.ts` — realClassify() via OpenAI-compatible API
- `bench/compaction/model-reference-selector.ts` — compactor with env-var-driven real/mock classifier
- `src/core/dump-context.ts` — session context extraction for classifier input
- DeepSeek Flash real-session test — promshim-ch session, 74 chunks classified in 5.1s, ~$0.001
