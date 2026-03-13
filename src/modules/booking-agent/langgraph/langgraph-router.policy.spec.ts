import { describe, expect, it } from "vitest";
import { buildState, buildVehicleOption } from "./langgraph.factory";
import { resolveRouteDecision } from "./langgraph-router.policy";

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
      extraction: { intent: "provide_info", draftPatch: {}, confidence: 0.9 },
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
      extraction: { intent: "provide_info", draftPatch: {}, confidence: 0.9 },
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

  it("routes to cancelled for cancel intent during confirming", () => {
    const vehicle = buildVehicleOption();
    const state = buildState({
      stage: "confirming",
      inboundMessage: "cancel",
      selectedOption: vehicle,
      availableOptions: [vehicle],
      extraction: { intent: "cancel", draftPatch: {}, confidence: 0.95 },
    });

    const decision = resolveRouteDecision(state);
    expect(decision.nextNode).toBe("respond");
    expect(decision.stage).toBe("cancelled");
  });

  it("keeps confirming stage for low-confidence bare cancel intent", () => {
    const vehicle = buildVehicleOption();
    const state = buildState({
      stage: "confirming",
      inboundMessage: "cancel",
      selectedOption: vehicle,
      availableOptions: [vehicle],
      extraction: { intent: "cancel", draftPatch: {}, confidence: 0.6 },
    });

    const decision = resolveRouteDecision(state);
    expect(decision.nextNode).toBe("respond");
    expect(decision.stage).toBe("confirming");
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

  it("routes reject+show_alternatives to search when required fields are complete", () => {
    const state = buildState({
      draft: {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        pickupLocation: "Victoria Island",
        dropoffDate: "2026-03-01",
        dropoffLocation: "Lekki",
        vehicleType: "SUV",
        color: "white",
      },
      extraction: {
        intent: "reject",
        draftPatch: {},
        preferenceHint: "show_alternatives",
        confidence: 1,
      },
      selectedOption: buildVehicleOption(),
      availableOptions: [buildVehicleOption()],
    });

    const decision = resolveRouteDecision(state);
    expect(decision.nextNode).toBe("search");
    expect(decision.stage).toBe("searching");
    expect(decision.selectedOption).toBeNull();
    expect(decision.availableOptions).toEqual([]);
    expect(decision.lastShownOptions).toEqual([]);
  });
});
