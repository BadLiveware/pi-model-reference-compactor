#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);

const valueOf = (name, fallback) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const hasFlag = (name) => args.includes(name);

const baselineRef = valueOf("--baseline", "53dc551");
const headRef = valueOf("--head", "HEAD");
const compactors = valueOf("--compactors", "pi-vcc");
const realSessionsDir = valueOf("--real-sessions-dir");
const realLimit = valueOf("--real-limit");
const caseFilter = valueOf("--case-filter");
const outDir = resolve(valueOf("--out", join(tmpdir(), `pi-vcc-compaction-compare-${Date.now()}`)));
const keepWorktrees = hasFlag("--keep-worktrees");
const includeRealOnly = hasFlag("--real-only");
const includeLayerDiff = hasFlag("--show-layer-diff");
const includeProbes = hasFlag("--include-probes");

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const rendered = `${command} ${commandArgs.join(" ")}`;
    if (options.capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    throw new Error(`Command failed (${result.status}): ${rendered}`);
  }
  return result.stdout ?? "";
};

const repoRoot = run("git", ["rev-parse", "--show-toplevel"], { capture: true }).trim();

const ensureRef = (ref) => {
  run("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoRoot, capture: true });
};

const safeName = (value) => value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "ref";
const runId = `${Date.now()}-${process.pid}`;
const worktreeRoot = join(tmpdir(), `pi-vcc-ref-compare-${runId}`);
const baselineWorktree = join(worktreeRoot, `baseline-${safeName(baselineRef)}`);
const headWorktree = join(worktreeRoot, `head-${safeName(headRef)}`);

const benchArgs = () => {
  const out = ["--jsonl", "--compactors", compactors];
  if (includeRealOnly) out.push("--real-only");
  if (realSessionsDir) out.push("--real-sessions-dir", "/sessions");
  if (realLimit) out.push("--real-limit", realLimit);
  if (caseFilter) out.push("--case-filter", caseFilter);
  if (includeLayerDiff) out.push("--show-layer-diff");
  if (includeProbes) out.push("--include-probes");
  return out;
};

const readJsonl = (path) => readFileSync(path, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const correctnessFailures = (cycle) => [
  ...(cycle.missingActiveTerms ?? []),
  ...(cycle.missingCurrentTerms ?? []),
  ...(cycle.missingRecallTerms ?? []),
  ...(cycle.leakedForbiddenTerms ?? []),
  ...(cycle.leakedForbiddenCurrentTerms ?? []),
  ...(cycle.leakedActiveAbsentTerms ?? []),
].length;

const cacheBoundaries = JSON.parse(readFileSync(resolve(repoRoot, "bench/compaction/cache-boundaries.json"), "utf8"));

const cacheFailures = (cycle) => {
  const boundary = cacheBoundaries[cycle.caseId];
  if (!boundary || cycle.cycle <= 1) return 0;
  let count = 0;
  if (cycle.firstChangedPromptLayer && !boundary.allowedFirstChangedLayers.includes(cycle.firstChangedPromptLayer)) count += 1;
  if ((cycle.stablePrefixTokens ?? 0) < boundary.minStablePrefixTokens) count += 1;
  for (const [layer, maxSize] of Object.entries(boundary.maxPromptLayerSizes ?? {})) {
    if ((cycle.promptLayerSizes?.[layer] ?? 0) > maxSize) count += 1;
  }
  return count;
};

const mean = (items, selector) => {
  const values = items.map(selector).filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const fmt = (value, digits = 2) => value === null || value === undefined ? "n/a" : Number(value).toFixed(digits);
const signed = (value, digits = 2) => value === null || value === undefined ? "n/a" : `${value >= 0 ? "+" : ""}${Number(value).toFixed(digits)}`;

const RECENT_MUTABLE_LAYERS = [
  "Pi MRC Recent Scope Updates",
  "Pi MRC Recent User Preferences",
  "Pi MRC Recent Evidence Handles",
];

const layerRank = (layer) => {
  if (!layer) return 999;
  if (layer === "Provider Prefix") return 0;
  if (layer === "Tool Definitions") return 1;
  if (layer === "Project Instructions") return 2;
  if (layer.startsWith("Pi MRC Session Goal")) return 3;
  if (layer.startsWith("Pi MRC Files")) return 4;
  if (layer.startsWith("Pi MRC Commits")) return 5;
  if (layer.startsWith("Pi MRC Evidence Handles")) return 6;
  if (layer.startsWith("Pi MRC User Preferences")) return 7;
  if (layer.startsWith("Pi MRC Current Scope")) return 8;
  if (layer.startsWith("Pi MRC Recent")) return 9;
  if (layer.startsWith("Pi MRC Outstanding")) return 10;
  if (layer.startsWith("Pi MRC Brief")) return 11;
  if (layer === "Kept Raw Tail") return 12;
  return 50;
};

const rowLabel = (row) => `${row.caseId} / ${row.compactor} / cycle ${row.cycle}`;

const summarize = (label, rows) => ({
  label,
  cycles: rows.length,
  meanStablePrefixTokens: mean(rows, (row) => row.stablePrefixTokens),
  meanFullPromptTokensEst: mean(rows, (row) => row.fullPromptTokensEst),
  meanCurrentTokensEst: mean(rows, (row) => row.currentTokensEst),
  correctnessFailureCycles: rows.filter((row) => correctnessFailures(row) > 0).length,
  cacheFailureCycles: rows.filter((row) => cacheFailures(row) > 0).length,
});

const keyOf = (row) => `${row.caseId}\u0000${row.compactor}\u0000${row.cycle}`;

const markdownReport = ({ baselineRows, headRows, baselinePath, headPath }) => {
  const baseline = summarize("baseline", baselineRows);
  const head = summarize("head", headRows);
  const baselineByKey = new Map(baselineRows.map((row) => [keyOf(row), row]));
  const pairs = headRows
    .map((headRow) => ({ baselineRow: baselineByKey.get(keyOf(headRow)), headRow }))
    .filter((pair) => pair.baselineRow);
  const stableDeltas = pairs.map(({ baselineRow, headRow }) => (headRow.stablePrefixTokens ?? 0) - (baselineRow.stablePrefixTokens ?? 0));
  const tokenDeltas = pairs.map(({ baselineRow, headRow }) => headRow.fullPromptTokensEst - baselineRow.fullPromptTokensEst);
  const currentDeltas = pairs.map(({ baselineRow, headRow }) => headRow.currentTokensEst - baselineRow.currentTokensEst);
  const improved = pairs.filter(({ baselineRow, headRow }) =>
    (headRow.stablePrefixTokens ?? 0) > (baselineRow.stablePrefixTokens ?? 0)
    || correctnessFailures(headRow) < correctnessFailures(baselineRow)
    || cacheFailures(headRow) < cacheFailures(baselineRow)
  );
  const regressed = pairs.filter(({ baselineRow, headRow }) =>
    (headRow.stablePrefixTokens ?? 0) < (baselineRow.stablePrefixTokens ?? 0)
    || correctnessFailures(headRow) > correctnessFailures(baselineRow)
    || cacheFailures(headRow) > cacheFailures(baselineRow)
  );
  const notable = pairs
    .filter(({ baselineRow, headRow }) => baselineRow.firstChangedPromptLayer !== headRow.firstChangedPromptLayer
      || correctnessFailures(baselineRow) !== correctnessFailures(headRow)
      || cacheFailures(baselineRow) !== cacheFailures(headRow))
    .slice(0, 20);
  const worstStablePrefixDeltas = pairs
    .filter(({ baselineRow, headRow }) => baselineRow.stablePrefixTokens != null && headRow.stablePrefixTokens != null)
    .map(({ baselineRow, headRow }) => ({ baselineRow, headRow, delta: headRow.stablePrefixTokens - baselineRow.stablePrefixTokens }))
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 10);
  const largestPromptGrowth = pairs
    .map(({ baselineRow, headRow }) => ({ baselineRow, headRow, delta: headRow.fullPromptTokensEst - baselineRow.fullPromptTokensEst }))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 10);
  const earliestFirstChanged = headRows
    .filter((row) => row.cycle > 1 && row.firstChangedPromptLayer)
    .sort((a, b) => layerRank(a.firstChangedPromptLayer) - layerRank(b.firstChangedPromptLayer) || (a.stablePrefixTokens ?? 0) - (b.stablePrefixTokens ?? 0))
    .slice(0, 10);
  const largestRecentLayers = headRows
    .flatMap((row) => RECENT_MUTABLE_LAYERS.map((layer) => ({ row, layer, size: row.promptLayerSizes?.[layer] ?? 0 })))
    .filter((entry) => entry.size > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, 10);

  const lines = [];
  lines.push("# Compaction Ref Comparison");
  lines.push("");
  lines.push(`- Baseline ref: \`${baselineRef}\``);
  lines.push(`- Head ref: \`${headRef}\``);
  lines.push(`- Compactors: \`${compactors}\``);
  if (realSessionsDir) lines.push(`- Real sessions: \`${realSessionsDir}\``);
  if (realLimit) lines.push(`- Real session limit: \`${realLimit}\``);
  if (caseFilter) lines.push(`- Case filter: \`${caseFilter}\``);
  if (includeProbes) lines.push("- Probe cases: included");
  lines.push(`- Baseline JSONL: \`${baselinePath}\``);
  lines.push(`- Head JSONL: \`${headPath}\``);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push("| metric | baseline | head | delta |");
  lines.push("| --- | ---: | ---: | ---: |");
  lines.push(`| cycles | ${baseline.cycles} | ${head.cycles} | ${head.cycles - baseline.cycles} |`);
  lines.push(`| mean stable prefix tokens | ${fmt(baseline.meanStablePrefixTokens)} | ${fmt(head.meanStablePrefixTokens)} | ${signed(mean(stableDeltas, (v) => v))} |`);
  lines.push(`| mean full prompt tokens | ${fmt(baseline.meanFullPromptTokensEst)} | ${fmt(head.meanFullPromptTokensEst)} | ${signed(mean(tokenDeltas, (v) => v))} |`);
  lines.push(`| mean current tokens | ${fmt(baseline.meanCurrentTokensEst)} | ${fmt(head.meanCurrentTokensEst)} | ${signed(mean(currentDeltas, (v) => v))} |`);
  lines.push(`| correctness failure cycles | ${baseline.correctnessFailureCycles} | ${head.correctnessFailureCycles} | ${head.correctnessFailureCycles - baseline.correctnessFailureCycles} |`);
  lines.push(`| cache failure cycles | ${baseline.cacheFailureCycles} | ${head.cacheFailureCycles} | ${head.cacheFailureCycles - baseline.cacheFailureCycles} |`);
  lines.push("");
  lines.push("## Matched-cycle signals");
  lines.push("");
  lines.push(`- Matched cycles: ${pairs.length}`);
  lines.push(`- Improved cycles: ${improved.length}`);
  lines.push(`- Regressed cycles: ${regressed.length}`);
  lines.push("");
  lines.push("## Notable changed cycles");
  lines.push("");
  if (notable.length === 0) {
    lines.push("No notable first-layer, correctness, or cache-gate changes in matched cycles.");
  } else {
    lines.push("| case | compactor | cycle | baseline first layer | head first layer | stable prefix delta | correctness delta | cache delta |");
    lines.push("| --- | --- | ---: | --- | --- | ---: | ---: | ---: |");
    for (const { baselineRow, headRow } of notable) {
      lines.push(`| ${headRow.caseId} | ${headRow.compactor} | ${headRow.cycle} | ${baselineRow.firstChangedPromptLayer ?? "n/a"} | ${headRow.firstChangedPromptLayer ?? "n/a"} | ${signed((headRow.stablePrefixTokens ?? 0) - (baselineRow.stablePrefixTokens ?? 0), 0)} | ${correctnessFailures(headRow) - correctnessFailures(baselineRow)} | ${cacheFailures(headRow) - cacheFailures(baselineRow)} |`);
    }
  }
  lines.push("");
  lines.push("## Outliers");
  lines.push("");
  lines.push("### Worst stable-prefix deltas");
  lines.push("");
  lines.push("| case | baseline | head | delta | head first layer |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const { baselineRow, headRow, delta } of worstStablePrefixDeltas) {
    lines.push(`| ${rowLabel(headRow)} | ${baselineRow.stablePrefixTokens ?? "n/a"} | ${headRow.stablePrefixTokens ?? "n/a"} | ${signed(delta, 0)} | ${headRow.firstChangedPromptLayer ?? "n/a"} |`);
  }
  lines.push("");
  lines.push("### Largest full-prompt growth");
  lines.push("");
  lines.push("| case | baseline tokens | head tokens | delta | head first layer |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const { baselineRow, headRow, delta } of largestPromptGrowth) {
    lines.push(`| ${rowLabel(headRow)} | ${baselineRow.fullPromptTokensEst} | ${headRow.fullPromptTokensEst} | ${signed(delta, 0)} | ${headRow.firstChangedPromptLayer ?? "n/a"} |`);
  }
  lines.push("");
  lines.push("### Earliest changed head layers");
  lines.push("");
  lines.push("| case | first changed layer | stable prefix tokens | full prompt tokens |");
  lines.push("| --- | --- | ---: | ---: |");
  for (const row of earliestFirstChanged) {
    lines.push(`| ${rowLabel(row)} | ${row.firstChangedPromptLayer ?? "n/a"} | ${row.stablePrefixTokens ?? "n/a"} | ${row.fullPromptTokensEst} |`);
  }
  lines.push("");
  lines.push("### Largest recent mutable layers");
  lines.push("");
  if (largestRecentLayers.length === 0) {
    lines.push("No recent mutable layers were present in the head run.");
  } else {
    lines.push("| case | layer | chars |");
    lines.push("| --- | --- | ---: |");
    for (const { row, layer, size } of largestRecentLayers) {
      lines.push(`| ${rowLabel(row)} | ${layer} | ${size} |`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
};

const builtImages = [];

const runBench = ({ label, ref, worktree }) => {
  console.error(`Adding ${label} worktree for ${ref}`);
  run("git", ["worktree", "add", "--detach", worktree, ref], { cwd: repoRoot });
  const image = `pi-mrc-bench-${safeName(label)}-${runId}`.toLowerCase();
  console.error(`Building ${image}`);
  run("docker", ["build", "-t", image, "."], { cwd: worktree });
  builtImages.push(image);
  const jsonlPath = join(outDir, `${label}.jsonl`);
  const stderrPath = join(outDir, `${label}.stderr.log`);
  const dockerArgs = ["run", "--rm"];
  if (realSessionsDir) dockerArgs.push("-v", `${resolve(realSessionsDir)}:/sessions:ro`);
  dockerArgs.push(image, ...benchArgs());
  console.error(`Running ${label} benchmark`);
  const result = spawnSync("docker", dockerArgs, { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(jsonlPath, result.stdout ?? "");
  writeFileSync(stderrPath, result.stderr ?? "");
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${label} benchmark failed with status ${result.status}; see ${stderrPath}`);
  }
  return { jsonlPath, stderrPath };
};

try {
  ensureRef(baselineRef);
  ensureRef(headRef);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  const baseline = runBench({ label: "baseline", ref: baselineRef, worktree: baselineWorktree });
  const head = runBench({ label: "head", ref: headRef, worktree: headWorktree });
  const report = markdownReport({
    baselineRows: readJsonl(baseline.jsonlPath),
    headRows: readJsonl(head.jsonlPath),
    baselinePath: baseline.jsonlPath,
    headPath: head.jsonlPath,
  });
  const reportPath = join(outDir, "comparison.md");
  writeFileSync(reportPath, report);
  console.log(report);
  console.error(`Wrote ${reportPath}`);
} finally {
  if (!keepWorktrees && existsSync(worktreeRoot)) {
    for (const worktree of [baselineWorktree, headWorktree]) {
      if (existsSync(worktree)) {
        spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot, stdio: "ignore" });
      }
    }
    rmSync(worktreeRoot, { recursive: true, force: true });
    for (const image of builtImages) {
      spawnSync("docker", ["rmi", image], { stdio: "ignore" });
    }
  }
}
