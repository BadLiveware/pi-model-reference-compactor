/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { registerMrcReferenceJournalHook } from "../src/hooks/mrc-reference-journal";
import {
  buildCompactionMrcReferenceIndex,
  buildMrcReferenceJournal,
  insertBeforeLatestUserMessage,
  PI_MRC_REFERENCES_TYPE,
  renderEphemeralMrcRefs,
  renderMrcReferenceJournalContent,
  type MrcReferenceJournalDetails,
} from "../src/core/mrc-reference-journal";

const refDetails = (): MrcReferenceJournalDetails => ({
  version: 1,
  refs: [{
    id: "evidence:abc123",
    kind: "evidence",
    text: "Error signature ERR_TEST_123",
    summary: "lookup if evidence details are needed: error-signature evidence",
    source: "compaction",
    createdAt: "2026-05-14T00:00:00.000Z",
  }],
});

describe("MRC reference prompt metadata", () => {
  test("renders refs as internal metadata rather than a user request", () => {
    const content = renderMrcReferenceJournalContent(refDetails());

    expect(content).toContain("[MRC refs]");
    expect(content).toContain("metadata: internal mrc_lookup index, not a user request");
    expect(content).toContain("user-facing: handles are internal unless the user asks about refs");
  });

  test("injected ref metadata does not become the latest user message", () => {
    const refsMessage = {
      role: "custom",
      customType: PI_MRC_REFERENCES_TYPE,
      content: renderMrcReferenceJournalContent(refDetails()),
      display: false,
    };
    const latestUser = { role: "user", content: [{ type: "text", text: "continue real work" }] };
    const messages = [
      { role: "compactionSummary", summary: "prior work" },
      { role: "assistant", content: [{ type: "text", text: "ready" }] },
      latestUser,
    ];

    const result = insertBeforeLatestUserMessage(messages, refsMessage);

    expect(result.at(-1)).toBe(latestUser);
    expect(result.at(-2)).toMatchObject({ role: "custom", customType: PI_MRC_REFERENCES_TYPE });
  });

  test("does not render lookup refs when the summary already exposes the body", () => {
    const content = renderEphemeralMrcRefs([{
      type: "compaction",
      details: {
        modelReferenceIndex: {
          version: 1,
          refs: [
            {
              id: "goal:tiny",
              kind: "goal",
              text: "commit",
              summary: "lookup if goal context is needed: commit",
              source: "compaction",
              createdAt: "2026-05-14T00:00:00.000Z",
            },
            {
              id: "goal:prefix",
              kind: "goal",
              text: "Honestly, the implementer should inherit everything other than subagent delegation guidance.",
              summary: "lookup if goal context is needed: Honestly, the implementer should inherit everything other than subagent delegation guidance.",
              source: "compaction",
              createdAt: "2026-05-14T00:00:00.000Z",
            },
            {
              id: "evidence:good",
              kind: "evidence",
              text: "Error signature ERR_TEST_123",
              summary: "lookup if evidence details are needed: error-signature evidence",
              source: "compaction",
              createdAt: "2026-05-14T00:00:00.000Z",
            },
          ],
        },
      },
    }], 8, []);

    expect(content).toContain("ref:evidence:good");
    expect(content).not.toContain("ref:goal:tiny");
    expect(content).not.toContain("ref:goal:prefix");
    expect(content).not.toContain("ERR_TEST_123");
  });

  test("does not create refs for trivial one-word goals", () => {
    const journal = buildMrcReferenceJournal([
      { role: "user", content: [{ type: "text", text: "commit" }], timestamp: 0 } as any,
    ], { createdAt: "2026-05-14T00:00:00.000Z" });

    expect(journal?.refs ?? []).toEqual([]);
  });

  test("does not leak identifier-like topic tokens into new ref summaries", () => {
    const secretLike = "Fix production token sk_live_abcd1234 and customerSecretAlpha in the retry handler after validation fails.";
    const journal = buildMrcReferenceJournal([
      { role: "user", content: [{ type: "text", text: secretLike }], timestamp: 0 } as any,
    ], { createdAt: "2026-05-14T00:00:00.000Z" });

    const rendered = renderMrcReferenceJournalContent(journal!);
    expect(rendered).toContain("ref:");
    expect(rendered).not.toContain("sk_live_abcd1234");
    expect(rendered).not.toContain("customerSecretAlpha");
  });

  test("carries previous compaction refs even when they no longer render", () => {
    const carried = buildCompactionMrcReferenceIndex([
      {
        id: "c1",
        type: "compaction",
        details: {
          modelReferenceIndex: {
            version: 1,
            refs: [{
              id: "goal:legacy",
              kind: "goal",
              text: "commit",
              summary: "lookup if goal context is needed: commit",
              source: "compaction",
              createdAt: "2026-05-14T00:00:00.000Z",
            }],
          },
        },
      },
      { id: "k1", type: "message", message: { role: "user", content: [{ type: "text", text: "kept" }] } },
    ], "k1");

    expect(carried?.refs.map((ref) => ref.id)).toContain("goal:legacy");
  });

  test("context hook inserts MRC refs before the real latest user prompt", () => {
    let contextHandler: ((event: any, ctx: any) => any) | undefined;
    const pi = {
      on: (eventName: string, handler: (event: any, ctx: any) => any) => {
        if (eventName === "context") contextHandler = handler;
      },
    } as any;
    registerMrcReferenceJournalHook(pi);

    const latestUser = { role: "user", content: [{ type: "text", text: "continue the slice" }] };
    const result = contextHandler!({
      type: "context",
      messages: [
        { role: "compactionSummary", summary: "prior work" },
        latestUser,
      ],
    }, {
      sessionManager: {
        getSessionFile: () => "/tmp/pi-mrc-test-session.jsonl",
        getBranch: () => [{
          type: "compaction",
          details: { modelReferenceIndex: refDetails() },
        }],
      },
    });

    expect(result.messages.at(-1)).toBe(latestUser);
    expect(result.messages.at(-2)).toMatchObject({
      role: "custom",
      customType: PI_MRC_REFERENCES_TYPE,
      display: false,
    });
    expect(result.messages.at(-2).content).toContain("not a user request");
  });
});
