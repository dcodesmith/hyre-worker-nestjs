import { describe, expect, it } from "vitest";
import { LANGGRAPH_NODE_NAMES, LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE } from "./langgraph.const";
import { createDefaultLocationValidationState } from "./langgraph.interface";
import { RouteNode } from "./route.node";

describe("RouteNode", () => {
  const routeNode = new RouteNode();

  it("routes to respond/greeting on service outage marker", () => {
    const result = routeNode.run({
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
      error: LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.nextNode).toBe(LANGGRAPH_NODE_NAMES.RESPOND);
    expect(result.stage).toBe("greeting");
  });

  it("routes to search for early pickup validation in collecting flow", () => {
    const result = routeNode.run({
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
      nextNode: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.nextNode).toBe(LANGGRAPH_NODE_NAMES.SEARCH);
    expect(result.stage).toBe("collecting");
  });
});
