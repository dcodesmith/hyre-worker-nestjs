import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  LANGGRAPH_CHECKOUT_LINK_CONTENT_SID,
  LANGGRAPH_VEHICLE_CARD_CONTENT_SID,
} from "./langgraph.const";
import { buildVehicleOption } from "./langgraph.factory";
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
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn().mockReturnValue(undefined),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

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

    expect(responderServiceMock.generateResponse).toHaveBeenCalledTimes(1);
    expect(result.outboxItems?.[0]).toMatchObject({
      conversationId: "conv_1",
      textBody: "Hello there",
    });
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
    expect(result.outboxItems).toBeUndefined();
  });

  it("uses the shared vehicle-card template SID when env is unset", async () => {
    const vehicle = buildVehicleOption({ id: "veh_1" });
    responderServiceMock.generateResponse.mockResolvedValue({
      text: "Here are your options!",
      vehicleCards: [
        {
          vehicleId: "veh_1",
          imageUrl: null,
          caption: "Card",
          buttonId: "select_vehicle:veh_1",
          buttonTitle: "Select",
        },
      ],
    });

    const result = await respondNode.run({
      conversationId: "conv_1",
      inboundMessage: "show options",
      inboundMessageId: "msg_1",
      customerId: null,
      stage: "presenting_options",
      turnCount: 1,
      messages: [],
      draft: {},
      availableOptions: [vehicle],
      lastShownOptions: [vehicle],
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

    expect(
      result.outboxItems?.some((item) => item.templateName === LANGGRAPH_VEHICLE_CARD_CONTENT_SID),
    ).toBe(true);
  });

  it("uses the shared checkout template SID when env is unset", async () => {
    responderServiceMock.generateResponse.mockResolvedValue({
      text: "Complete payment",
    });

    const result = await respondNode.run({
      conversationId: "conv_1",
      inboundMessage: "yes",
      inboundMessageId: "msg_1",
      customerId: null,
      stage: "awaiting_payment",
      turnCount: 1,
      messages: [],
      draft: {},
      availableOptions: [],
      lastShownOptions: [],
      selectedOption: buildVehicleOption(),
      holdId: null,
      holdExpiresAt: null,
      bookingId: "bkg_1",
      paymentLink: "https://checkout-v2.dev-flutterwave.com/v3/hosted/pay/c60612d08d53343872af",
      preferences: {},
      response: null,
      outboxItems: [],
      extraction: null,
      nextNode: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.outboxItems).toEqual([
      expect.objectContaining({
        mode: "TEMPLATE",
        templateName: LANGGRAPH_CHECKOUT_LINK_CONTENT_SID,
        templateVariables: {
          "1": "Complete payment",
          "2": "c60612d08d53343872af",
        },
      }),
    ]);
  });
});
