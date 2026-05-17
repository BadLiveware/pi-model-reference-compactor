import { describe, it, expect } from "bun:test";
import { compile, compileWithLayers } from "../src/core/summarize";
import {
  userMsg,
  assistantText,
  assistantWithToolCall,
  toolResult,
} from "./fixtures";

describe("compile", () => {
  it("returns empty string for no messages", () => {
    expect(compile({ messages: [] })).toBe("");
  });

  it("produces hybrid output with header + brief transcript", () => {
    const r = compile({
      messages: [
        userMsg("Fix login bug"),
        assistantWithToolCall("Read", { path: "auth.ts" }),
        assistantText("Found the issue.\n1. Fix validation"),
      ],
    });
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("Fix login bug");
    expect(r).toContain("---");
    expect(r).toContain("[user]\nFix login bug");
    expect(r).toContain('* Read "auth.ts"');
    expect(r).toContain("Found the issue.");
  });

  it("exposes production layers without changing compiled text", () => {
    const input = {
      messages: [
        userMsg("Fix login bug"),
        assistantWithToolCall("Read", { path: "auth.ts" }),
        assistantText("Found the issue."),
      ],
    };
    const layered = compileWithLayers(input);
    expect(layered.text).toBe(compile(input));
    expect(layered.layers.map((layer) => layer.name)).toContain("Pi VCC Session Goal");
    expect(layered.layers.map((layer) => layer.name)).toContain("Pi VCC Brief Transcript");
    expect(layered.layers.at(-1)).toMatchObject({ name: "Pi VCC Recall Note", role: "recall" });
  });

  it("merges previous summary goals", () => {
    const r = compile({
      messages: [userMsg("New task")],
      previousSummary: "[Session Goal]\n- Original goal\n\n---\n\n[user]\nOriginal goal",
    });
    expect(r).toContain("- Original goal");
    expect(r).toContain("- New task");
  });

  it("appends brief transcript on merge", () => {
    const previousSummary = [
      "[Session Goal]\n- Original goal",
      "---",
      "[user]\nOriginal goal\n\n[assistant]\n* Read \"old.ts\"",
    ].join("\n\n");
    const r = compile({
      previousSummary,
      messages: [
        userMsg("Next step"),
        assistantWithToolCall("Read", { path: "new.ts" }),
      ],
    });
    expect(r).toContain('* Read "old.ts"');
    expect(r).toContain('* Read "new.ts"');
    expect(r).toContain("Next step");
  });

  it("outstanding context is volatile (fresh only)", () => {
    const previousSummary = "[Outstanding Context]\n- old blocker\n\n---\n\n[user]\nhi";
    const r = compile({
      previousSummary,
      messages: [userMsg("continue")],
    });
    expect(r).not.toContain("old blocker");
  });

  it("caps long brief transcript with rolling window", () => {
    // Build a very long previous transcript
    const longTranscript = Array.from({ length: 200 }, (_, i) =>
      `[user]\nmessage ${i}`
    ).join("\n\n");
    const previousSummary = `[Session Goal]\n- goal\n\n---\n\n${longTranscript}`;
    const r = compile({
      previousSummary,
      messages: [userMsg("latest")],
    });
    expect(r).toContain("earlier lines omitted");
    expect(r).toContain("latest");
  });

  it("supersedes stale positive preferences after explicit correction", () => {
    const previousSummary = "[User Preferences]\n- For this repo, prefer yarn test when validating.\n\n---\n\n[user]\nold";
    const r = compile({
      previousSummary,
      messages: [userMsg("Correction: never use yarn here. Use npm test for broad validation and node --test for focused checks.")],
    });
    const current = r.split("\n\n---\n\n")[0];
    expect(current).toContain("never use yarn");
    expect(current).toContain("npm test");
    expect(current).not.toContain("prefer yarn test");
  });

  it("preserves fresh brief-only updates when merging previous summary", () => {
    const previousSummary = "[Session Goal]\n- Existing goal\n\n---\n\n[user]\nExisting goal";
    const r = compile({
      previousSummary,
      messages: [
        userMsg("Status update: wiring is started; next validate dashboard provisioning."),
        assistantText("Next step: validate dashboard provisioning without changing the stable objective."),
      ],
    });
    expect(r).toContain("Existing goal");
    expect(r).toContain("validate dashboard provisioning");
  });

  it("demotes fresh goals to current scope when merging previous summary", () => {
    const previousSummary = "[Session Goal]\n- Existing goal\n\n---\n\n[user]\nExisting goal";
    const r = compile({
      previousSummary,
      messages: [userMsg("Also add meta monitoring dashboards")],
    });
    const current = r.split("\n\n---\n\n")[0];
    expect(current).toContain("[Session Goal]\n- Existing goal");
    expect(current).toContain("[Current Scope]\n- Also add meta monitoring dashboards");
  });

  it("keeps prior current scope when fresh window is status-only", () => {
    const previousSummary = "[Session Goal]\n- Existing goal\n\n[Current Scope]\n- Add meta monitoring\n\n---\n\n[user]\nExisting goal";
    const r = compile({
      previousSummary,
      messages: [userMsg("Status update: validate dashboard provisioning next")],
    });
    const current = r.split("\n\n---\n\n")[0];
    expect(current).toContain("[Current Scope]\n- Add meta monitoring");
  });

  it("preserves evidence handles when merging", () => {
    const previousSummary = "[Session Goal]\n- Existing goal\n\n[Evidence Handles]\n- Paths: src/cache/probe.ts\n- Identifiers: req_cache_beta\n\n---\n\n[user]\nExisting goal";
    const r = compile({
      previousSummary,
      messages: [userMsg("Status update: continue validation")],
    });
    const current = r.split("\n\n---\n\n")[0];
    expect(current).toContain("[Evidence Handles]\n- Paths: src/cache/probe.ts\n- Identifiers: req_cache_beta");
  });

  it("places newly discovered scope in a later recent section", () => {
    const previousSummary = "[Session Goal]\n- Existing goal\n\n[Current Scope]\n- Add dashboard provisioning checks\n\n---\n\n[user]\nExisting goal";
    const r = compile({
      previousSummary,
      messages: [userMsg("Also add provider cache accounting notes to the current scope")],
    });
    const current = r.split("\n\n---\n\n")[0];
    expect(current).toContain("[Current Scope]\n- Add dashboard provisioning checks");
    expect(current).toContain("[Recent Scope Updates]\n- Also add provider cache accounting notes to the current scope");
    expect(current.indexOf("[Current Scope]")).toBeLessThan(current.indexOf("[Recent Scope Updates]"));
  });

  it("places newly discovered preferences in a later recent section", () => {
    const previousSummary = "[Session Goal]\n- Existing goal\n\n[User Preferences]\n- Always use Docker for benchmarks\n\n---\n\n[user]\nExisting goal";
    const r = compile({
      previousSummary,
      messages: [userMsg("I would prefer query read only mode")],
    });
    const current = r.split("\n\n---\n\n")[0];
    expect(current).toContain("[User Preferences]\n- Always use Docker for benchmarks");
    expect(current).toContain("[Recent User Preferences]\n- I would prefer query read only mode");
    expect(current.indexOf("[User Preferences]")).toBeLessThan(current.indexOf("[Recent User Preferences]"));
  });

  it("applies preference corrections to the stable preference section", () => {
    const previousSummary = "[Session Goal]\n- Existing goal\n\n[User Preferences]\n- prefer yarn test\n\n---\n\n[user]\nExisting goal";
    const r = compile({
      previousSummary,
      messages: [userMsg("Correction: never use yarn here. Use npm test.")],
    });
    const current = r.split("\n\n---\n\n")[0];
    expect(current).toContain("never use yarn");
    expect(current).not.toContain("prefer yarn test");
    expect(current).not.toContain("[Recent User Preferences]");
  });

  it("places newly discovered evidence in a later recent section", () => {
    const previousSummary = "[Session Goal]\n- Existing goal\n\n[Evidence Handles]\n- Paths: src/cache/probe.ts\n\n---\n\n[user]\nExisting goal";
    const r = compile({
      previousSummary,
      messages: [toolResult("bash", "CACHE_LAYER_SHIFT request_id=req_cache_beta /tmp/cache-evidence-beta.log")],
    });
    const current = r.split("\n\n---\n\n")[0];
    expect(current).toContain("[Evidence Handles]\n- Paths: src/cache/probe.ts");
    expect(current).toContain("[Recent Evidence Handles]");
    expect(current).toContain("req_cache_beta");
    expect(current.indexOf("[Evidence Handles]")).toBeLessThan(current.indexOf("[Recent Evidence Handles]"));
  });

  it("places newly discovered commits in a later recent section", () => {
    const previousSummary = "[Session Goal]\n- Existing goal\n\n[Commits]\n- a1b2c3d: test: add cache churn probe\n\n---\n\n[user]\nExisting goal";
    const r = compile({
      previousSummary,
      messages: [
        assistantWithToolCall("bash", { command: "git commit -m \"fix: keep commit section stable\"" }),
        toolResult("bash", "[feat/cache b2c3d4e] fix: keep commit section stable"),
      ],
    });
    const current = r.split("\n\n---\n\n")[0];
    expect(current).toContain("[Commits]\n- a1b2c3d: test: add cache churn probe");
    expect(current).toContain("[Recent Commits]\n- b2c3d4e: fix: keep commit section stable");
    expect(current.indexOf("[Commits]")).toBeLessThan(current.indexOf("[Recent Commits]"));
  });
});
