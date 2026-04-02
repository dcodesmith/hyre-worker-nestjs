import { describe, expect, it } from "vitest";
import { HandoffNode } from "./handoff.node";
import { LANGGRAPH_OUTBOUND_MODE } from "./langgraph.const";
import { createDefaultLocationValidationState } from "./langgraph.interface";

describe("HandoffNode", () => {
  const handoffNode = new HandoffNode();

  it("returns handoff response, outbox, and cancelled stage", () => {
    const result = handoffNode.run({
      conversationId: "conv_1",
      inboundMessage: "agent",
      inboundMessageId: "msg_1",
      customerId: null,
      stage: "collecting",
      turnCount: 1,
      messages: [],
      draft: {},
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
      extraction: null,
      nextNode: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.stage).toBe("cancelled");
    expect(result.response?.text).toContain("Tripdly agent");
    expect(result.outboxItems).toHaveLength(1);
    expect(result.outboxItems?.[0]?.dedupeKey).toMatch(/^langgraph:handoff:/);
    expect(result.outboxItems?.[0]?.mode).toBe(LANGGRAPH_OUTBOUND_MODE.FREE_FORM);
  });
});
