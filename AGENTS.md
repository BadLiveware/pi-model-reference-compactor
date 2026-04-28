# AGENTS.md

## Project North Star

`pi-vcc` is an algorithmic conversation compactor for Pi. Its goal is not merely to make summaries shorter; it is to maximize expected continuation value after compaction.

Optimize compaction across these objectives:

1. **Recall fidelity** — important goals, constraints, files, identifiers, evidence handles, decisions, blockers, and next actions remain available either in active context or recall.
2. **Semantic coherence** — the compacted state should let the agent understand what is happening, why it matters, and what to do next.
3. **Post-compaction working room** — active prompt state should stay compact enough to leave useful room for future work.
4. **Retrieval dependence** — bulky or older detail may move out of active context only when it remains recoverable through transcript, recall, files, or artifacts.
5. **Cache preservation** — stable prompt prefixes should remain byte/token stable across ordinary compactions; volatile updates should be isolated into late recent/volatile sections.

A shorter summary is not better if it loses continuity, exact identifiers, recoverability, or cache reuse.

## Compaction Design Principles

- Prefer stable structured state over full-summary rewrites.
- Keep durable facts before volatile facts.
- Keep volatile updates in explicit recent/volatile sections.
- Preserve exact paths, identifiers, error signatures, request IDs, span/probe IDs, and commit references when they are relevant evidence.
- Offload bulky re-fetchable details to recall/history with pointers rather than active prompt bodies.
- Separate current truth from historical transcript. Stale or corrected facts may remain recallable, but must not remain current guidance.
- Treat prompt-cache churn as a first-class performance and cost concern.

## Current Cache-Aware Layout

Stable/current sections should remain as stable as possible:

```text
Session Goal
Files And Changes
Commits
Evidence Handles
User Preferences
Current Scope
```

Recent/volatile sections may change more often and should stay bounded:

```text
Recent Commits
Recent Scope Updates
Recent User Preferences
Recent Evidence Handles
Outstanding Context
Brief Transcript
Kept Raw Tail
```

Do not move volatile content back into stable sections without benchmark-backed evidence.

## Benchmarking Expectations

Use the Docker benchmark path as the primary validation route:

```bash
docker build -t pi-vcc-bench .
docker run --rm pi-vcc-bench --compactors pi-vcc --assert
docker run --rm pi-vcc-bench --compactors pi-vcc --assert-cache
```

For original-vs-current comparisons:

```bash
node scripts/compare-compaction-refs.mjs \
  --baseline 53dc551 \
  --head HEAD \
  --compactors pi-vcc \
  --out /tmp/pi-vcc-compaction-compare
```

For real-session cache behavior:

```bash
node scripts/compare-compaction-refs.mjs \
  --baseline 53dc551 \
  --head HEAD \
  --compactors pi-vcc \
  --real-only \
  --real-sessions-dir ~/.pi/agent/sessions \
  --real-limit 5 \
  --show-layer-diff \
  --out /tmp/pi-vcc-real-compare
```

## Interpreting Results

Good changes should generally:

- preserve or improve correctness assertions
- preserve or improve cache-boundary assertions
- move `firstChangedPromptLayer` later, not earlier
- increase stable-prefix tokens for repeated compactions
- avoid growing full prompt tokens unless the added state is justified
- keep recent/volatile sections bounded

If a change improves one metric while hurting another, judge it by expected continuation value, not by any single metric alone.

## Development Guidance

- Add a focused RED probe before or alongside compaction behavior changes.
- Keep synthetic probes for exact correctness and cache-boundary behavior.
- Use real-session replay to find outliers and avoid overfitting synthetic cases.
- Prefer small semantic commits that can be reviewed and reverted independently.
- Do not claim cache improvements without fresh benchmark evidence.
