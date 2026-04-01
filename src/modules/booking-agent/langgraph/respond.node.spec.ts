import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLocationValidationState } from "./langgraph.interface";
import { LangGraphResponderService } from "./langgraph-responder.service";
import { RespondNode } from "./respond.node";

describe("RespondNode", () => {
  let moduleRef: TestingModule;
  let respondNode: RespondNode;

  const responderServiceMock = {
    generateResponse: vi.fn(),
  };

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        RespondNode,
        { provide: LangGraphResponderService, useValue: responderServiceMock },
      ],
    }).compile();

    respondNode = moduleRef.get(RespondNode);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  it("returns no-op when response and outbox already exist", async () => {
    const result = await respondNode.run({
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
      nextNode: null,
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

    const result = await respondNode.run({
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
      nextNode: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.response?.text).toBe("Hello there");
    expect(result.outboxItems).toHaveLength(1);
  });

  it("returns fallback response when responder fails", async () => {
    responderServiceMock.generateResponse.mockRejectedValue(new Error("Responder unavailable"));

    const result = await respondNode.run({
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
      nextNode: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.error).toBeTruthy();
    expect(result.response?.text).toContain("I'm having trouble right now");
  });
});
