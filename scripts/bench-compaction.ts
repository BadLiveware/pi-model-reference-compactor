#!/usr/bin/env node
import { failedCacheGatesOf, failedGatesOf, offlineCompactors, runOfflineCompactionBenchmark } from "../bench/compaction/offline-runner";
import { continuationProbeCases, syntheticCompactionCases } from "../bench/compaction/synthetic-cases";
import { loadRealSessionCases } from "../bench/compaction/real-sessions";
import { formatCompactionReportCard } from "../src/core/compaction-report";

const args = process.argv.slice(2);

const argValue = (name: string): string | undefined => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return undefined;
};

const hasFlag = (name: string): boolean => args.includes(name);

const realSessionsDir = argValue("--real-sessions-dir");
const realLimitRaw = argValue("--real-limit");
if (realLimitRaw !== undefined && !/^[1-9]\d*$/.test(realLimitRaw)) {
  console.error(`Invalid --real-limit: ${realLimitRaw}`);
  process.exit(1);
}
const realLimit = realLimitRaw ? Number.parseInt(realLimitRaw, 10) : undefined;
const caseFilter = argValue("--case-filter");
const includeDiagnostics = hasFlag("--show-layer-diff");
const includeReports = hasFlag("--include-report") || hasFlag("--explain");
const includeProbes = hasFlag("--include-probes");

const selected = argValue("--compactors")
  ?.split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const compactors = selected
  ? offlineCompactors.filter((compactor) => selected.includes(compactor.name))
  : offlineCompactors;

if (selected && compactors.length !== selected.length) {
  const found = new Set(compactors.map((compactor) => compactor.name));
  const missing = selected.filter((name) => !found.has(name));
  console.error(`Unknown compactor(s): ${missing.join(", ")}`);
  console.error(`Available compactors: ${offlineCompactors.map((compactor) => compactor.name).join(", ")}`);
  process.exit(1);
}

const cases = hasFlag("--real-only") ? [] : [...syntheticCompactionCases, ...(includeProbes ? continuationProbeCases : [])];
if (realSessionsDir) {
  cases.push(...await loadRealSessionCases({ sessionsDir: realSessionsDir, limit: realLimit }));
}
const filteredCases = caseFilter
  ? cases.filter((testCase) => testCase.id.includes(caseFilter) || testCase.description.includes(caseFilter))
  : cases;

const result = await runOfflineCompactionBenchmark({ compactors, cases: filteredCases, includeDiagnostics, includeReports });
const failures = result.cycles
  .map((cycle) => ({ cycle, gates: failedGatesOf(cycle) }))
  .filter((entry) => entry.gates.length > 0);
const cacheFailures = result.cycles
  .map((cycle) => ({ cycle, gates: failedCacheGatesOf(cycle) }))
  .filter((entry) => entry.gates.length > 0);

if (hasFlag("--explain")) {
  for (const cycle of result.cycles) {
    console.log(`## ${cycle.caseId} / ${cycle.compactor} / cycle ${cycle.cycle}`);
    console.log(`compactionPoint=${cycle.compactionPoint} firstChangedPromptLayer=${cycle.firstChangedPromptLayer ?? "none"} stablePrefixTokens=${cycle.stablePrefixTokens ?? "n/a"}`);
    if (cycle.compactionReport) {
      console.log(formatCompactionReportCard(cycle.compactionReport, { expanded: true }));
    } else {
      console.log("No compaction report available for this compactor.");
    }
    console.log("");
  }
} else if (hasFlag("--jsonl")) {
  for (const cycle of result.cycles) {
    console.log(JSON.stringify(cycle));
  }
} else {
  console.log(JSON.stringify(result, null, 2));
}

const printFailures = (title: string, entries: typeof failures) => {
  console.error(`\n${title}: ${entries.length} cycle(s)`);
  for (const { cycle, gates } of entries.slice(0, 20)) {
    console.error(JSON.stringify({
      caseId: cycle.caseId,
      compactor: cycle.compactor,
      cycle: cycle.cycle,
      gates,
      firstChangedPromptLayer: cycle.firstChangedPromptLayer,
      stablePrefixTokens: cycle.stablePrefixTokens,
      missingActiveTerms: cycle.missingActiveTerms,
      missingCurrentTerms: cycle.missingCurrentTerms,
      missingRecallTerms: cycle.missingRecallTerms,
      leakedForbiddenTerms: cycle.leakedForbiddenTerms,
      leakedForbiddenCurrentTerms: cycle.leakedForbiddenCurrentTerms,
      leakedActiveAbsentTerms: cycle.leakedActiveAbsentTerms,
    }));
  }
  if (entries.length > 20) {
    console.error(`... ${entries.length - 20} additional failing cycle(s) omitted`);
  }
};

if (hasFlag("--assert") && failures.length > 0) {
  printFailures("Compaction benchmark assertions failed", failures);
  process.exit(1);
}

if (hasFlag("--assert-cache") && cacheFailures.length > 0) {
  printFailures("Compaction cache assertions failed", cacheFailures);
  process.exit(1);
}
