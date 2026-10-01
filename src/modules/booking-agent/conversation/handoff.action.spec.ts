import { describe, expect, it } from "vitest";
import { HandoffAction } from "./handoff.action";
import { BOOKING_AGENT_OUTBOUND_MODE } from "./conversation.const";
import { createDefaultLocationValidationState } from "./conversation.interface";

describe("HandoffAction", () => {
  const handoffAction = new HandoffAction();

  it("returns handoff response, outbox, and cancelled stage", () => {
    const result = handoffAction.run({
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
      nextAction: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.stage).toBe("cancelled");
    expect(result.response?.text).toContain("Tripdly agent");
    expect(result.outboxItems).toHaveLength(1);
    expect(result.outboxItems?.[0]?.dedupeKey).toMatch(/^booking-agent:handoff:/);
    expect(result.outboxItems?.[0]?.mode).toBe(BOOKING_AGENT_OUTBOUND_MODE.FREE_FORM);
  });
});
