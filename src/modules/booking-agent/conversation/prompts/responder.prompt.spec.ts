import { describe, expect, it } from "vitest";
import { buildResponderUserContext } from "./responder.prompt";

describe("responder.prompt contract", () => {
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
        nextAction: null,
        error: null,
        statusMessage: null,
      },
      { maxContextFieldChars: 300, maxDraftContextChars: 600, maxOptionContextItems: 5 },
    );

    expect(context).toContain("CURRENT STATE: collecting");
    expect(context).toContain("USER INTENT: provide_info");
    expect(context).toContain("MISSING REQUIRED FIELDS:");
    expect(context).toContain("vehicleType");
    expect(context).toContain("INSTRUCTION: Ask for ALL missing fields");
  });

  it("includes status message in user context when present", () => {
    const context = buildResponderUserContext(
      {
        messages: [],
        conversationId: "conv_1",
        customerId: null,
        inboundMessage: "Okay",
        inboundMessageId: "msg_1",
        inboundInteractive: undefined,
        draft: {},
        stage: "collecting",
        turnCount: 3,
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
        nextAction: null,
        error: null,
        statusMessage:
          "No vehicles matching your criteria are available for the selected date. Would you like to try a different date, vehicle type, or booking type?",
      },
      { maxContextFieldChars: 300, maxDraftContextChars: 600, maxOptionContextItems: 5 },
    );

    expect(context).toContain("STATUS MESSAGE:");
    expect(context).toContain("No vehicles matching your criteria");
    expect(context).toContain(
      "INSTRUCTION: Include this status update clearly before asking for next details.",
    );
  });

  it("does not claim a reservation or active hold while awaiting payment", () => {
    const context = buildResponderUserContext(
      {
        messages: [],
        conversationId: "conv_1",
        customerId: null,
        inboundMessage: "I paid",
        inboundMessageId: "msg_1",
        inboundInteractive: undefined,
        draft: {},
        stage: "awaiting_payment",
        turnCount: 4,
        extraction: null,
        availableOptions: [],
        lastShownOptions: [],
        selectedOption: null,
        holdId: null,
        holdExpiresAt: null,
        bookingId: "booking_1",
        paymentLink: "https://pay.example.com/invoice/123",
        preferences: {},
        response: null,
        outboxItems: [],
        nextAction: null,
        error: null,
        statusMessage: null,
      },
      { maxContextFieldChars: 300, maxDraftContextChars: 600, maxOptionContextItems: 5 },
    );

    expect(context).toContain("payment is required to confirm the booking");
    expect(context).toContain("Do not claim a reservation");
    expect(context).not.toContain("HOLD EXPIRY:");
    expect(context).not.toMatch(/HOLD ACTIVE/i);
    expect(context).not.toMatch(/has been reserved|vehicle is now reserved/i);
  });

  it("asks for reserved-until wording when a payment hold expiry is present", () => {
    const holdExpiresAt = "2026-03-01T15:30:00.000Z";
    const context = buildResponderUserContext(
      {
        messages: [],
        conversationId: "conv_1",
        customerId: null,
        inboundMessage: "I paid",
        inboundMessageId: "msg_1",
        inboundInteractive: undefined,
        draft: {},
        stage: "awaiting_payment",
        turnCount: 4,
        extraction: null,
        availableOptions: [],
        lastShownOptions: [],
        selectedOption: null,
        holdId: "booking_1",
        holdExpiresAt,
        bookingId: "booking_1",
        paymentLink: "https://pay.example.com/invoice/123",
        preferences: {},
        response: null,
        outboxItems: [],
        nextAction: null,
        error: null,
        statusMessage: null,
      },
      { maxContextFieldChars: 300, maxDraftContextChars: 600, maxOptionContextItems: 5 },
    );

    expect(context).toContain(`HOLD EXPIRY: ${holdExpiresAt}`);
    expect(context).toContain("reserved until");
    expect(context).not.toMatch(/HOLD ACTIVE/i);
  });
});
