import { describe, expect, it } from "vitest";
import type { BookingAgentState, VehicleSearchOption } from "./langgraph.interface";
import { resolveRouteDecision } from "./langgraph-router.policy";

function buildVehicleOption(overrides?: Partial<VehicleSearchOption>): VehicleSearchOption {
  return {
    id: "vehicle_1",
    make: "Toyota",
    model: "Prado",
    name: "Toyota Prado",
    color: "black",
    vehicleType: "SUV",
    serviceTier: "EXECUTIVE",
    imageUrl: null,
    rates: { day: 65000, night: 70000, fullDay: 110000, airportPickup: 40000 },
    estimatedTotalInclVat: 150000,
    ...overrides,
  };
}

function buildState(overrides?: Partial<BookingAgentState>): BookingAgentState {
  return {
    messages: [],
    conversationId: "conv_1",
    customerId: null,
    inboundMessage: "",
    inboundMessageId: "msg_1",
    inboundInteractive: undefined,
    draft: {},
    stage: "collecting",
    turnCount: 1,
    extraction: { intent: "provide_info", draftPatch: {}, confidence: 0.9 },
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
    ...overrides,
  };
}

describe("langgraph-router.policy", () => {
  it("routes to search when all required fields exist and options are empty", () => {
    const state = buildState({
      draft: {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        pickupLocation: "Victoria Island",
        dropoffDate: "2026-03-01",
        dropoffLocation: "Lekki",
      },
    });

    const decision = resolveRouteDecision(state);
    expect(decision.nextNode).toBe("search");
    expect(decision.stage).toBe("searching");
  });

  it("routes to presenting_options when options already exist", () => {
    const state = buildState({
      draft: {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        pickupLocation: "Victoria Island",
        dropoffDate: "2026-03-01",
        dropoffLocation: "Lekki",
      },
      availableOptions: [buildVehicleOption()],
    });

    const decision = resolveRouteDecision(state);
    expect(decision.nextNode).toBe("respond");
    expect(decision.stage).toBe("presenting_options");
  });

  it("routes to create_booking for affirmative confirming response", () => {
    const state = buildState({
      stage: "confirming",
      inboundMessage: "yes please, go ahead",
      selectedOption: buildVehicleOption(),
      extraction: { intent: "provide_info", draftPatch: {}, confidence: 0.4 },
    });

    const decision = resolveRouteDecision(state);
    expect(decision.nextNode).toBe("create_booking");
  });

  it("routes to collecting and clears selection for negative confirming response", () => {
    const vehicle = buildVehicleOption();
    const state = buildState({
      stage: "confirming",
      inboundMessage: "no, show me another option",
      selectedOption: vehicle,
      availableOptions: [vehicle],
      extraction: { intent: "provide_info", draftPatch: {}, confidence: 0.4 },
    });

    const decision = resolveRouteDecision(state);
    expect(decision.nextNode).toBe("respond");
    expect(decision.stage).toBe("collecting");
    expect(decision.selectedOption).toBeNull();
    expect(decision.availableOptions).toEqual([]);
  });

  it("does not route to create_booking for affirmative response outside confirming stage", () => {
    const state = buildState({
      stage: "awaiting_payment",
      inboundMessage: "yes",
      selectedOption: buildVehicleOption(),
      extraction: { intent: "provide_info", draftPatch: {}, confidence: 0.4 },
    });

    const decision = resolveRouteDecision(state);
    expect(decision.nextNode).not.toBe("create_booking");
  });

  it("clears state for reset intent", () => {
    const decision = resolveRouteDecision(
      buildState({
        extraction: { intent: "reset", draftPatch: {}, confidence: 1 },
        selectedOption: buildVehicleOption(),
        availableOptions: [buildVehicleOption()],
      }),
    );

    expect(decision.stage).toBe("greeting");
    expect(decision.draft).toEqual({ __clear: true });
    expect(decision.availableOptions).toEqual([]);
  });
});
