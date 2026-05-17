# Compaction Benchmark

This benchmark evaluates conversation compaction as a continuation system, not only as a compression routine. It focuses on whether a compacted agent state preserves recoverable work while keeping cacheable prompt prefixes stable.

The design borrows the pressure-test loop used for skill validation: first make the current behavior fail in a controlled scenario, then implement the smallest compaction change that fixes the observed failure, and rerun the same scenario plus nearby variants.

## Evaluation loop

Use the benchmark as a RED-GREEN-REFACTOR loop for compaction behavior:

1. **RED**: run the current compactor and record exact failures such as missing identifiers, stale current facts, bulky active text, or unstable early layers.
2. **GREEN**: add the smallest targeted compaction change that fixes the observed failure.
3. **REFACTOR**: pressure-test adjacent cases so the fix does not only satisfy one string probe.
4. **ITERATE**: keep the failing scenario in the benchmark and repeat until the desired compactor passes or the intended semantics need to change.

Do not implement broad cache-aware layering only from design intuition. Add or keep a failing probe for each behavior the implementation is meant to improve.

## Compactors under comparison

The runner uses a common offline interface:

- `pi-vcc`: current deterministic `compile()` output.
- `full-rewrite-checkpoint`: deterministic stand-in for a regenerated structured summary plus transcript, without external recall.
- `cache-aware-layered`: deterministic layered prototype that separates stable schema, durable memory, structured checkpoint, rolling transcript, raw tail, and recall pointers.

LLM-backed compactors can be added behind the same interface. Live model calls should be kept separate from the default offline run so local validation remains cheap and deterministic.

## Benchmark levels

The current harness covers the first level and some cache-churn signals. Later levels should be added before using benchmark results to claim end-to-end agent quality.

1. **Offline state probes**
   - exact active terms
   - current-state terms
   - recall-only terms
   - forbidden current-state terms
   - terms that must stay out of active prompt text
   - layer churn and longest common prefix

2. **Micro-continuation probes**
   - compacted context plus a tiny disposable fixture
   - agent gets a one-to-three action budget
   - pass/fail by expected command, file, or decision

3. **Hermetic Pi replay**
   - isolated `PI_CODING_AGENT_DIR`
   - actual compaction hook and session context construction
   - optional default-model and small-model continuation probes

4. **Live provider cache probes**
   - provider-reported cached and uncached tokens
   - latency to first token and total latency
   - effective input cost over the next few turns

## Scenario shape

Each synthetic case contains:

- an ordered message transcript
- one or more compaction points to replay repeated compactions
- exact terms that should remain somewhere in active prompt state
- exact terms that should be in current-state layers, not only historical transcript or raw tail
- exact terms that may be absent from active state but must be recoverable from recall
- terms that must not appear in current-state layers after corrections or branch-sensitive updates
- terms that must stay out of active prompt text because recall should carry them
- continuation terms that indicate the agent can resume the next action

Real Pi sessions can be added later as fixtures or sampled from local session JSONL files, but synthetic cases provide gold expectations for regressions.

## Scoped assertions

The runner distinguishes scopes so historical fidelity is not confused with current state:

- `activeTerms`: must appear anywhere in the active compacted prompt.
- `currentTerms`: must appear in current-state layers.
- `recallTerms`: must be recoverable from recall corpus search.
- `forbiddenTerms`: must not appear anywhere in the active compacted prompt.
- `forbiddenCurrentTerms`: must not appear in current-state layers, but may exist in historical transcript/tail or recall corpus.
- `activeAbsentTerms`: must not appear in active prompt text; they are expected to live in recall only.

This matters for corrections. For example, an old preference may remain in historical transcript, but it must not remain in durable memory or the current checkpoint after a user correction.

## Metrics

Each compaction cycle records:

- active state size in characters and approximate tokens
- current-state size in characters and approximate tokens
- compaction latency
- longest common prefix with the previous compacted prompt
- first changed layer and changed layer names when a compactor exposes layers
- active exact-term recall against gold terms
- current-state exact-term recall against gold terms
- forbidden active and current-state leakage
- active leakage of terms expected to be recall-only
- recall top-k recovery for externalized terms
- continuation-term recovery

The cache-oriented metrics are offline approximations. They do not replace provider-reported cached-token accounting, but they highlight prompt churn that is likely to hurt prefix-based caching.

## Full-prompt cache simulation

Each cycle also builds a simulated provider prompt so cache churn can be measured outside the compacted summary alone. The simulated prompt contains stable provider/tool/project layers, the compactor's rendered layers, and a small kept raw tail. For `pi-vcc`, current summary sections are split into separate simulated prompt layers so the report can identify which section changes first. This does not exactly reproduce Pi's production request, but it catches the main prefix-cache risk: a volatile update moving earlier than necessary.

Additional cache fields include:

- `fullPromptChars` and `fullPromptTokensEst`
- `fullPromptLcpTokensWithPrevious`
- `fullPromptLcpTokenRatioWithPrevious`
- `firstChangedPromptLayer`
- `changedPromptLayers`
- `stablePrefixTokens`
- `promptLayerSizes`
- `promptLayerTokenDeltas`

Use these fields to compare section ordering and stable/volatile splits before adding live provider probes. A better cache-aware layout should generally increase `stablePrefixTokens`, push `firstChangedPromptLayer` later, and keep volatile deltas out of static/current prefix layers when the underlying facts did not change.

## Running

Run all offline compactors:

```bash
bun scripts/bench-compaction.ts
```

Emit one JSON record per compaction cycle:

```bash
bun scripts/bench-compaction.ts --jsonl > bench-results.jsonl
```

Limit the comparison to selected compactors:

```bash
bun scripts/bench-compaction.ts --compactors pi-vcc,cache-aware-layered
```

Run assertion mode. This exits non-zero if any selected compactor misses active/current/recall/continuation expectations or leaks forbidden/offloaded terms:

```bash
bun scripts/bench-compaction.ts --compactors pi-vcc --assert
```

Run cache assertion mode for synthetic cache-stability probes. This is separate from correctness assertions and checks that each cache probe first changes only at its intended recent/volatile boundary, with a minimum stable-prefix token floor:

```bash
bun scripts/bench-compaction.ts --compactors pi-vcc --assert-cache
```

The current cache-boundary probes are:

- `cache-bust-volatile-next-step`: first change should be `Pi VCC Outstanding Context` or later.
- `cache-bust-evidence-growth`: first change should be `Pi VCC Recent Evidence Handles` or later.
- `cache-bust-scope-growth`: first change should be `Pi VCC Recent Scope Updates` or later.
- `cache-bust-mutable-tail-growth`: first change should be in a recent/volatile layer and recent layer sizes must stay under their caps.
- `cache-bust-commit-growth`: new commits should first change `Pi VCC Recent Commits`, not the stable `Pi VCC Commits` section.
- `cache-bust-long-evidence-line`: long fresh evidence should first change `Pi VCC Recent Evidence Handles` while keeping that layer under its size cap.
- `cache-bust-long-scope-line`: verbose fresh scope should first change `Pi VCC Recent Scope Updates` while keeping that layer under its size cap.
- `cache-bust-long-preference-line`: verbose fresh preferences should first change `Pi VCC Recent User Preferences` while keeping that layer under its size cap.

Append sampled real Pi sessions from a local session directory. Real-session cases have no gold state assertions; they are useful for size, latency, growth, and cache-churn signals:

```bash
bun scripts/bench-compaction.ts \
  --real-sessions-dir ~/.pi/agent/sessions \
  --real-limit 2 \
  --compactors pi-vcc
```

Run only sampled real sessions:

```bash
bun scripts/bench-compaction.ts \
  --real-only \
  --real-sessions-dir ~/.pi/agent/sessions \
  --real-limit 2 \
  --compactors pi-vcc \
  --jsonl
```

Filter cases and include concise layer diffs when investigating cache churn:

```bash
bun scripts/bench-compaction.ts \
  --real-only \
  --real-sessions-dir ~/.pi/agent/sessions \
  --case-filter ch-observability \
  --compactors pi-vcc \
  --show-layer-diff \
  --jsonl
```

Include pi-vcc's machine-readable compaction report in each JSON/JSONL cycle when you need section policies, stable/recent churn, caps, and warnings:

```bash
bun scripts/bench-compaction.ts \
  --compactors pi-vcc \
  --case-filter cache-bust-scope-growth \
  --include-report \
  --jsonl
```

Print a human-readable report explanation instead of JSON:

```bash
bun scripts/bench-compaction.ts \
  --compactors pi-vcc \
  --case-filter cache-bust-scope-growth \
  --explain
```

Run the same checks in Docker:

```bash
docker build -t pi-vcc-bench .
docker run --rm pi-vcc-bench
docker run --rm pi-vcc-bench --compactors pi-vcc --assert
docker run --rm \
  -v ~/.pi/agent/sessions:/sessions:ro \
  pi-vcc-bench \
  --real-only \
  --real-sessions-dir /sessions \
  --real-limit 2 \
  --compactors pi-vcc \
  --jsonl
```

Assertion failures are expected for current baselines while the RED scenarios are documenting known gaps. Use selected compactors when checking one implementation at a time.

## Comparing refs

Use the ref comparison runner when you need an original-vs-implementation benchmark instead of a single working-tree run. It creates isolated git worktrees, builds each ref as its own Docker image, runs the same benchmark command in both images, and writes paired JSONL plus a Markdown delta report.

A practical runnable baseline is `53dc551`, the cache-stability assertion checkpoint before the later production layout/extraction refinements. Compare it with the current checkout:

```bash
node scripts/compare-compaction-refs.mjs \
  --baseline 53dc551 \
  --head HEAD \
  --compactors pi-vcc \
  --out /tmp/pi-vcc-compaction-compare
```

Older refs can be useful historically, but they must contain a runnable version of the benchmark harness and its source dependencies.

Include sampled real sessions with the same Docker-only benchmark path:

```bash
node scripts/compare-compaction-refs.mjs \
  --baseline 53dc551 \
  --head HEAD \
  --compactors pi-vcc \
  --real-only \
  --real-sessions-dir ~/.pi/agent/sessions \
  --real-limit 1 \
  --show-layer-diff \
  --out /tmp/pi-vcc-compaction-compare-real
```

The output directory contains:

- `baseline.jsonl`: per-cycle metrics for the baseline ref
- `head.jsonl`: per-cycle metrics for the implementation ref
- `comparison.md`: aggregate deltas and notable changed cycles
- `baseline.stderr.log` / `head.stderr.log`: benchmark diagnostics from each Docker run

For cache-aware compaction, the most useful report signals are:

- increased mean stable-prefix tokens
- later `firstChangedPromptLayer` in matched cycles
- fewer cache failure cycles
- no increase in correctness failure cycles
- lower or justified full-prompt token counts

## Interpreting results

A useful compactor should:

- preserve exact identifiers, file paths, evidence handles, constraints, blockers, and next actions
- keep current state separate from historical transcript and raw tail
- avoid retaining corrected stale facts in current-state layers
- keep stable layers byte-identical across ordinary compactions
- move bulky re-fetchable details behind recall pointers without losing top-k recoverability
- reduce active prompt size without shifting too much cost into uncached post-compaction turns

Shorter output is not sufficient if continuation or recall probes fail.

## Future live-provider extension

A live cache probe should replay the same compacted prompts against providers that report cache usage and capture:

- cached input tokens
- uncached input tokens
- cache-write tokens
- latency to first token
- total request latency
- effective input cost over the next few turns

That extension should be opt-in because it depends on credentials, provider-specific cache semantics, and billable requests.
