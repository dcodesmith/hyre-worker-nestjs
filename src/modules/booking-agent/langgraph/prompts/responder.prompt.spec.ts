import { describe, expect, it } from "vitest";
import { buildResponderSystemPrompt, buildResponderUserContext } from "./responder.prompt";

describe("responder.prompt contract", () => {
  it("contains critical responder constraints", () => {
    const prompt = buildResponderSystemPrompt({
      messages: [],
      conversationId: "conv_1",
      customerId: null,
      inboundMessage: "hello",
      inboundMessageId: "msg_1",
      inboundInteractive: undefined,
      draft: {},
      stage: "collecting",
      turnCount: 2,
      extraction: null,
      availableOptions: [],
      lastShownOptions: [],
      selectedOption: null,
      holdId: null,
      holdExpiresAt: null,
      bookingId: null,
      paymentLink: null,
      preferences: {},
      response: null,
      outboxItems: [],
      nextNode: null,
      error: null,
    });

    expect(prompt).toContain("YOUR PERSONALITY:");
    expect(prompt).toContain("REQUIRED FIELDS FOR SEARCH");
    expect(prompt).toContain("NEVER ASK FOR:");
  });

  it("builds stage-aware user context", () => {
    const context = buildResponderUserContext(
      {
        messages: [],
        conversationId: "conv_1",
        customerId: null,
        inboundMessage: "I need a ride tomorrow",
        inboundMessageId: "msg_1",
        inboundInteractive: undefined,
        draft: {},
        stage: "collecting",
        turnCount: 2,
        extraction: { intent: "provide_info", draftPatch: {}, confidence: 0.7 },
        availableOptions: [],
        lastShownOptions: [],
        selectedOption: null,
        holdId: null,
        holdExpiresAt: null,
        bookingId: null,
        paymentLink: null,
        preferences: {},
        response: null,
        outboxItems: [],
        nextNode: null,
        error: null,
      },
      { maxContextFieldChars: 300, maxDraftContextChars: 600, maxOptionContextItems: 5 },
    );

    expect(context).toContain("CURRENT STATE: collecting");
    expect(context).toContain("USER INTENT: provide_info");
    expect(context).toContain("MISSING REQUIRED FIELDS:");
    expect(context).toContain("INSTRUCTION: Ask for ALL missing fields");
  });
});
