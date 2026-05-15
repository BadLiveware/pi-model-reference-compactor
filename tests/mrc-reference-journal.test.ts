import { describe, expect, test } from "bun:test";
import { registerMrcReferenceJournalHook } from "../src/hooks/mrc-reference-journal";
import {
  insertBeforeLatestUserMessage,
  PI_MRC_REFERENCES_TYPE,
  renderMrcReferenceJournalContent,
  type MrcReferenceJournalDetails,
} from "../src/core/mrc-reference-journal";

const refDetails = (): MrcReferenceJournalDetails => ({
  version: 1,
  refs: [{
    id: "evidence:abc123",
    kind: "evidence",
    text: "Error signature ERR_TEST_123",
    summary: "lookup if evidence details are needed: Error signature ERR_TEST_123",
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
