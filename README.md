# pi-mrc

This is a fork of `@sting8k/pi-vcc`, currently installed from GitHub or a local clone.

`pi-mrc` is a Model-Reference Compactor for [Pi](https://github.com/badlogic/pi-mono). It compacts conversation history into a small continuation state, stashes recoverable detail behind exact handles, and appends only the latest needed lookup index at the end of the model context.

The goal is not fuzzy transcript search or the shortest possible summary. The goal is: **after compaction, the next agent should know what to do, have room to work, and recover exact hidden context by handle when needed.**

## What pi-mrc optimizes

- **Continuation fidelity** — active goals, constraints, decisions, evidence handles, blockers, and next actions survive compaction.
- **Working room** — bulky old context is moved out of the active prompt.
- **Exact recoverability** — stashed details are resolved through `mrc_lookup`, not broad fuzzy search.
- **Cache stability** — stable guidance and KEEP chunks stay in the summary; volatile reference lists are appended as a late ephemeral suffix.
- **Source recoverability** — repository source is authoritative and rereadable, so source refs preserve locators instead of stale copied code bodies.

## Install

Install this fork directly from GitHub:

```bash
pi install https://github.com/BadLiveware/pi-model-reference-compactor
```

Or clone the fork and install/use the local checkout:

```bash
git clone https://github.com/BadLiveware/pi-model-reference-compactor.git
cd pi-model-reference-compactor
pi install .
```

For one-off local testing from the checkout:

```bash
pi -e .
```

## Quick use

Manual MRC compaction:

```text
/pi-mrc
```

Disable automatic pi-mrc interception for this session:

```text
/pi-mrc-off
```

Re-enable it:

```text
/pi-mrc-on
```

Inspect compaction reports:

```text
/pi-mrc-report show
/pi-mrc-report json inline
/pi-mrc-report list
```

Resolve an exact handle:

```text
mrc_lookup({ ref: "evidence:79dq9m" })
mrc_lookup({ ref: "ref:read-context:df20oq" })
```

List recent known handles:

```text
mrc_lookup({ list: true, limit: 10 })
```

`mrc_lookup` is exact lookup over MRC references in the active lineage. It is intentionally not fuzzy transcript search.

## How MRC compaction works

pi-mrc turns conversation state into referenceable chunks and classifies them into three tiers:

- **KEEP** — directly needed for the next read/edit/bash call.
- **REF** — useful later, but recoverable by handle.
- **DROP** — stale, duplicate, source-visible, or otherwise not worth preserving.

The compaction summary contains:

1. a minimum viable summary (MVS),
2. selected KEEP chunks,
3. stable instructions for interpreting refs,
4. no dynamic full ref inventory.

Dynamic refs are deliberately kept out of the summary. If the summary rewrote a changing list of refs on every compaction, it would churn early prompt context and reduce provider cache reuse.

## Context shape

During normal turns, pi-mrc stores full reference bodies in non-context session state and adds tiny handle anchors near the turn. After compaction, it advertises only refs that were stashed by the latest compaction and are not already visible.

Provider payload after a compaction looks like:

```text
SYSTEM / tools / AGENTS.md / skills
+
Compaction summary with MVS, KEEP chunks, and stable ref guidance
+
Kept recent transcript tail
+
User: Continue the implementation
+
[MRC refs]
Internal latest-compaction stash. Prefer visible context; use mrc_lookup only if needed. Source refs are locators; reread files for code. Do not expose handles unless asked.
- ref:evidence:79dq9m — lookup if evidence details are needed: Error signatures: ERR_FOO_123
- ref:read-context:df20oq — lookup if recent read-file locator is needed: Source locator: src/core/foo.ts; symbols: buildFoo, parseFoo; reread the repo...
```

Before compaction, tiny anchors may appear near prior turns:

```text
Assistant: I patched src/core/foo.ts and reran the focused test.
[MRC anchors: ref:evidence:79dq9m ref:read-context:df20oq]
```

Those anchors are intentionally small. They let a future compaction preserve lookup continuity without copying large hidden bodies into prompt text.

## Reference lifecycle

| Piece | Persisted? | Sent to model? | Purpose |
| --- | --- | --- | --- |
| Hidden ref state | Yes, non-context custom entries | No | Stores exact bodies for `mrc_lookup`. |
| `[MRC anchors: ...]` | Yes, tiny custom messages | Yes, near the turn | Gives compaction handle breadcrumbs. |
| Compaction stash | Yes, in compaction details | No direct prompt body | Records refs cut away by the latest compaction. |
| `[MRC refs]` suffix | No, rebuilt per model call | Yes, always last | Advertises latest-compaction stashed refs only. |

Design decisions:

- **Exact handles beat fuzzy search.** The model should recover known stashed facts by handle, not search the whole transcript.
- **Anchors are not user-facing.** The model is told not to mention or expose handles unless explicitly asked about compaction internals.
- **A handle is not evidence.** The model should call `mrc_lookup` before relying on hidden contents.
- **The suffix is ephemeral.** It is appended after the current user message so earlier context remains cacheable.

## Source recoverability

Repository source can be reread and may change. pi-mrc therefore stores source refs as locators, not copied source bodies.

Example hidden body for a read-file ref:

```text
Source locator: src/core/foo.ts; symbols: veryImportantHandler, helper; reread the repository file for authoritative source.
```

This preserves the route back to the source without making stale snippets look authoritative.

pi-mrc keeps full hidden bodies for context that is not cheaply recoverable from files:

- exact error output,
- benchmark results,
- request IDs, span IDs, trace IDs, and probe IDs,
- user decisions and constraints,
- deleted or dirty edits not present in current files,
- non-obvious investigation conclusions.

## `mrc_lookup`

`mrc_lookup` resolves exact handles from hidden ref state and latest compaction stash details.

Lookup by handle:

```text
mrc_lookup({ ref: "evidence:79dq9m" })
```

Example result:

```text
## ref:evidence:79dq9m
kind: evidence
source: compaction
entry: 42 @ 2026-05-10T12:34:56.000Z
summary: lookup if evidence details are needed: Error signatures: ERR_FOO_123

Error signatures: ERR_FOO_123
```

List recent refs:

```text
mrc_lookup({ list: true, limit: 10 })
```

No fuzzy query mode is provided. If broad transcript search is wanted later, it should be a separate tool with a separate name and policy.

## Commands and tools

| Name | Kind | Description |
| --- | --- | --- |
| `/pi-mrc` | command | Run MRC compaction manually. |
| `/pi-mrc-off` | command | Disable pi-mrc interception for this session. |
| `/pi-mrc-on` | command | Re-enable pi-mrc interception for this session. |
| `/pi-mrc-report` | command | Show or write latest compaction report artifacts. |
| `/pi-mrc-dump-context` | command | Debug current real context buffer or extracted session context. |
| `mrc_lookup` | tool | Resolve exact MRC `ref:*` handles and hidden bodies. |

## Configuration

Config lives at `~/.pi/agent/pi-mrc-config.json` and is scaffolded on first load:

```json
{
  "overrideDefaultCompaction": true,
  "debug": false
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `overrideDefaultCompaction` | `true` | When true, pi-mrc handles `/compact`, auto-threshold, overflow retry compactions, and `/pi-mrc`. When false, only `/pi-mrc` is intercepted. |
| `debug` | `false` | Write `/tmp/pi-mrc-debug.json` after compaction with cut boundary, counts, summary preview, and stash stats. |

## Compaction reports

After pi-mrc compacts, it emits a report card with:

- source and kept message counts,
- skipped internal message counts,
- summary size and total MRC compaction timing,
- compaction details containing the hidden `modelReferenceIndex` stash.

Artifacts are written under `/tmp/pi-mrc-reports`.

## Benchmarking and validation

Build the benchmark image:

```bash
docker build -t pi-mrc-bench .
```

Run MRC assertion gates:

```bash
docker run --rm pi-mrc-bench --compactors model-reference-selector --assert
```

The old structured compactor remains in the benchmark harness as an internal baseline, not the public product surface:

```bash
docker run --rm pi-mrc-bench --compactors pi-vcc --assert
docker run --rm pi-mrc-bench --compactors pi-vcc --assert-cache
```

Compare revisions:

```bash
node scripts/compare-compaction-refs.mjs \
  --baseline 53dc551 \
  --head HEAD \
  --compactors pi-vcc \
  --out /tmp/pi-mrc-compaction-compare
```

Real-session replay:

```bash
docker run --rm \
  -v ~/.pi/agent/sessions:/sessions:ro \
  pi-mrc-bench \
  --real-only \
  --real-sessions-dir /sessions \
  --real-limit 5 \
  --compactors pi-vcc \
  --jsonl
```

Recent validation for the MRC path passed:

- `model-reference-selector --assert`,
- focused smokes for anchors, latest-compaction stash, no-precompaction refs, guidance, exact lookup, and source-locator refs,
- legacy structured `pi-vcc --assert` and `pi-vcc --assert-cache` while that baseline remains in the harness.

`53dc551` is the pre-MRC structured baseline used for repo-local comparisons. Pi's built-in compactor is not exported as a callable API, so this benchmark does not directly compare against Pi internal compaction.

## Design principles

- **MRC + exact lookup is the product.** Fuzzy recall is intentionally out of scope.
- **Keep dynamic refs late.** The latest ref index is an ephemeral postfix, not summary text.
- **Keep handles internal.** Refs are agent continuity metadata, not user-facing prose.
- **Reread source.** File/symbol locators are safer than copied code snippets.
- **Preserve unrecoverable facts.** Exact errors, constraints, benchmark results, and user decisions must remain in prompt or lookup.
- **Validate cache behavior.** Use Docker gates and real-session replay before claiming continuation or cache wins.

## License

MIT
