import { describe, expect, it } from "bun:test";
import { extractEvidence, formatEvidence } from "../src/extract/evidence";
import type { NormalizedBlock } from "../src/types";

describe("extractEvidence", () => {
  it("normalizes trailing punctuation on paths", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "Read /home/fl/code/project/src/app.ts. Then compare src/app.ts," },
    ];
    const evidence = extractEvidence(blocks);
    expect([...evidence.paths]).toContain("/home/fl/code/project/src/app.ts");
    expect([...evidence.paths]).toContain("src/app.ts");
    expect([...evidence.paths]).not.toContain("/home/fl/code/project/src/app.ts.");
    expect([...evidence.paths]).not.toContain("src/app.ts,");
  });

  it("drops broad absolute directories while keeping files and tmp artifacts", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "/home/fl/code/project /home/fl/code/project/values.yaml /tmp/cache-evidence-beta.log /var/lib/grafana/dashboards" },
    ];
    const evidence = extractEvidence(blocks);
    expect([...evidence.paths]).toContain("/home/fl/code/project/values.yaml");
    expect([...evidence.paths]).toContain("/tmp/cache-evidence-beta.log");
    expect([...evidence.paths]).not.toContain("/home/fl/code/project");
    expect([...evidence.paths]).not.toContain("/var/lib/grafana/dashboards");
  });

  it("formats retained evidence handles", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "CACHE_LAYER_SHIFT request_id=req_cache_beta /tmp/cache-evidence-beta.log" },
    ];
    expect(formatEvidence(extractEvidence(blocks)).join("\n")).toContain("req_cache_beta");
  });

  it("clips long evidence lines with a stable overflow suffix", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "tool_result",
        name: "bash",
        text: Array.from({ length: 24 }, (_, i) => `/tmp/pi-vcc-cache-evidence/very/deep/path/cache-proof-artifact-${i}.json`).join("\n"),
        isError: false,
      },
    ];
    const pathsLine = formatEvidence(extractEvidence(blocks)).find((line) => line.startsWith("Paths:"));
    expect(pathsLine).toBeDefined();
    expect(pathsLine!.length).toBeLessThanOrEqual(235);
    expect(pathsLine).toContain("(+more)");
  });
});
