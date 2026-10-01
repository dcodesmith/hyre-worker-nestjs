import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createDefaultLocationValidationState } from "./conversation.interface";
import { BookingAgentResponderService } from "./booking-agent-responder.service";
import { RespondAction } from "./respond.action";

describe("RespondAction", () => {
  let moduleRef: TestingModule;
  let respondAction: RespondAction;

  const responderServiceMock = {
    generateResponse: vi.fn(),
  };

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        RespondAction,
        { provide: BookingAgentResponderService, useValue: responderServiceMock },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    respondAction = moduleRef.get(RespondAction);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  it("returns no-op when response and outbox already exist", async () => {
    const result = await respondAction.run({
      conversationId: "conv_1",
      inboundMessage: "hello",
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
      response: { text: "already sent" },
      outboxItems: [
        {
          conversationId: "conv_1",
          dedupeKey: "k1",
          mode: "FREE_FORM",
          textBody: "already sent",
        },
      ],
      extraction: null,
      nextAction: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result).toEqual({});
    expect(responderServiceMock.generateResponse).not.toHaveBeenCalled();
  });

  it("builds response and outbox when responder succeeds", async () => {
    responderServiceMock.generateResponse.mockResolvedValue({
      text: "Hello there",
    });

    const result = await respondAction.run({
      conversationId: "conv_1",
      inboundMessage: "hello",
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

    expect(result.response?.text).toBe("Hello there");
    expect(result.outboxItems).toHaveLength(1);

    expect(responderServiceMock.generateResponse).toHaveBeenCalledTimes(1);
    expect(result.outboxItems?.[0]).toMatchObject({
      conversationId: "conv_1",
      textBody: "Hello there",
    });
  });

  it("returns fallback response when responder fails", async () => {
    responderServiceMock.generateResponse.mockRejectedValue(new Error("Responder unavailable"));

    const result = await respondAction.run({
      conversationId: "conv_1",
      inboundMessage: "hello",
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

    expect(result.error).toBeTruthy();
    expect(result.response?.text).toContain("I'm having trouble right now");
    expect(result.outboxItems).toBeUndefined();
  });
});
