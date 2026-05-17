import { describe, it, expect } from "bun:test";
import { extractGoals } from "../src/extract/goals";
import type { NormalizedBlock } from "../src/types";

describe("extractGoals", () => {
  it("returns empty for no blocks", () => {
    expect(extractGoals([])).toEqual([]);
  });

  it("returns empty when no user blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "hello" },
    ];
    expect(extractGoals(blocks)).toEqual([]);
  });

  it("extracts first user message lines as goals", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug\nCheck auth flow" },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toEqual(["Fix login bug", "Check auth flow"]);
  });

  it("takes up to 6 lines from first user block", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "fix the login bug\ncheck auth flow\nupdate the tests\nrefactor utils\nclean up" },
    ];
    expect(extractGoals(blocks)).toHaveLength(5);
  });

  it("ignores subsequent user blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "first goal" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "second request" },
    ];
    expect(extractGoals(blocks)).toEqual(["first goal"]);
  });

  it("keeps explicit pivot keywords out of stable goals", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "Actually, instead let's refactor the auth module" },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toEqual(["Fix login bug"]);
  });

  it("keeps new task statements out of stable goals", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug" },
      { kind: "assistant", text: "done" },
      { kind: "user", text: "Now implement the user registration flow" },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toEqual(["Fix login bug"]);
  });

  it("keeps stable goals unchanged across multiple scope changes", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug" },
      { kind: "assistant", text: "done" },
      { kind: "user", text: "Actually, fix the signup page instead" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "Change of plan, implement password reset" },
    ];
    expect(extractGoals(blocks)).toEqual(["Fix login bug"]);
  });

  it("skips noise short user messages as goals", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "ok" },
      { kind: "assistant", text: "hello" },
      { kind: "user", text: "Fix the authentication module" },
    ];
    const goals = extractGoals(blocks);
    expect(goals[0]).toContain("Fix the authentication");
    expect(goals.some((g) => g === "ok")).toBe(false);
  });

  it("keeps volatile blocker updates out of stable goals", () => {
    const goals = extractGoals([
      { kind: "user", text: "Benchmark cache-aware compaction. Stable objective: preserve Layer 0 and Layer 1 prefixes." },
      { kind: "user", text: "Blocker update: offline LCP metrics are done; now add recall top-k metrics." },
      { kind: "user", text: "Current blocker: cached-token accounting is missing." },
    ]);
    expect(goals).toEqual([
      "Benchmark cache-aware compaction. Stable objective: preserve Layer 0 and Layer 1 prefixes.",
    ]);
  });

  it("keeps pasted kubernetes status tables out of stable goals", () => {
    const goals = extractGoals([
      { kind: "user", text: "Fix chart naming" },
      { kind: "user", text: "NAME READY STATUS RESTARTS AGE\ngrafana-db-1 1/1 Running 0 101m" },
    ]);
    expect(goals).toEqual(["Fix chart naming"]);
  });

  it("keeps direct preference instructions out of stable goals", () => {
    const goals = extractGoals([
      { kind: "user", text: "Install kube-prometheus-stack" },
      { kind: "user", text: "I hate verbose naming; please use the name fix thing they provide" },
    ]);
    expect(goals).toEqual(["Install kube-prometheus-stack"]);
  });

  it("keeps pasted config fragments out of stable goals", () => {
    const goals = extractGoals([
      { kind: "user", text: "Fix dashboard provisioning" },
      { kind: "user", text: "kind: ConfigMap\nmetadata:\ncreationTimestamp: \"2026-04-19T22:23:16Z\"\nlabels:\napp: grafana\napp.kubernetes.io/instance: monitoring\nchart: kubePrometheusStack-83.6.0\ngrafana_dashboard: \"1\"\nresourceVersion: \"21956\"\nuid: d27df580-8819-472e-90d4-0ac281b138f5" },
    ]);
    expect(goals).toEqual(["Fix dashboard provisioning"]);
  });

  it("keeps pasted commands and JSON logs out of stable goals", () => {
    const goals = extractGoals([
      { kind: "user", text: "Fix dashboard provisioning" },
      { kind: "user", text: "❯ kubectl get cm monitoring-k8s-monitoring-cluster-total -oyaml\n{\"time\": \"2026-04-19T22:20:47Z\", \"msg\": \"Starting collector\", \"level\": \"INFO\"}" },
    ]);
    expect(goals).toEqual(["Fix dashboard provisioning"]);
  });
});
