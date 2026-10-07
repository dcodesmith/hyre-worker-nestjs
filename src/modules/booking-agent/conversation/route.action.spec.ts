import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { BOOKING_AGENT_ACTIONS } from "./conversation.const";
import { createDefaultLocationValidationState } from "./conversation.interface";
import { RouteAction } from "./route.action";

describe("RouteAction", () => {
  let routeAction: RouteAction;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [RouteAction],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    routeAction = moduleRef.get(RouteAction);
  });

  it("routes to respond/greeting on service outage marker", () => {
    const result = routeAction.run({
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
      error:
        "This service is temporarily unavailable. Please try again in a moment or type booking online at https://legacy.example.com.",
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.nextAction).toBe(BOOKING_AGENT_ACTIONS.RESPOND);
    expect(result.stage).toBe("greeting");
  });

  it("routes to search for early pickup validation in collecting flow", () => {
    const result = routeAction.run({
      conversationId: "conv_1",
      inboundMessage: "pick me up from Ikoyi",
      inboundMessageId: "msg_1",
      customerId: null,
      stage: "collecting",
      turnCount: 1,
      messages: [],
      draft: {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Ikoyi",
      },
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
      extraction: {
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.9,
      },
      nextAction: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.nextAction).toBe(BOOKING_AGENT_ACTIONS.SEARCH);
    expect(result.stage).toBe("collecting");
  });
});
