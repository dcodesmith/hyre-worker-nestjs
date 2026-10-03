import { describe, expect, it } from "vitest";
import type { PublicAddon } from "../../addons/addons.interface";
import { resolveRouteDecision } from "./booking-agent-router.policy";
import { BOOKING_AGENT_BUTTON_ID } from "./conversation.const";
import { buildPricingPreview, buildState, buildVehicleOption } from "./conversation.factory";

describe("booking-agent-router.policy", () => {
  it("routes to search when all required fields exist and options are empty", () => {
    const state = buildState({
      draft: {
        bookingType: "DAY",
        vehicleType: "SUV",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        pickupLocation: "Victoria Island",
        dropoffDate: "2026-03-01",
        dropoffLocation: "Lekki",
      },
      extraction: { intent: "provide_info", draftPatch: {}, confidence: 0.9 },
    });

    const decision = resolveRouteDecision(state);
    expect(decision.nextAction).toBe("search");
    expect(decision.stage).toBe("searching");
  });

  it("routes to presenting_options when options already exist", () => {
    const state = buildState({
      draft: {
        bookingType: "DAY",
        vehicleType: "SUV",
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
    expect(decision.nextAction).toBe("respond");
    expect(decision.stage).toBe("presenting_options");
  });

  it("keeps collecting when vehicle type is missing", () => {
    const state = buildState({
      draft: {
        bookingType: "DAY",
        make: "Toyota",
        model: "Prado",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        pickupLocation: "Victoria Island",
        dropoffDate: "2026-03-01",
        dropoffLocation: "Lekki",
      },
      extraction: { intent: "provide_info", draftPatch: {}, confidence: 0.9 },
    });

    expect(resolveRouteDecision(state)).toEqual({
      nextAction: "respond",
      stage: "collecting",
    });
  });

  it("routes to create_booking for affirmative confirming response when the quote is ready", () => {
    const state = buildState({
      stage: "confirming",
      inboundMessage: "yes please, go ahead",
      selectedOption: buildVehicleOption(),
      pricingPreview: buildPricingPreview(),
      extraction: { intent: "provide_info", draftPatch: {}, confidence: 0.4 },
    });

    const decision = resolveRouteDecision(state);
    expect(decision.nextAction).toBe("create_booking");
  });

  it("prepares the quote before creating a booking when confirmation has no priced quote", () => {
    const decision = resolveRouteDecision(
      buildState({
        stage: "confirming",
        inboundMessage: "yes",
        selectedOption: buildVehicleOption(),
        extraction: { intent: "confirm", draftPatch: {}, confidence: 1 },
      }),
    );

    expect(decision.nextAction).toBe("prepare_quote");
  });

  it("handles retry and agent buttons after the transient error has been cleared", () => {
    const base = {
      stage: "confirming" as const,
      error: null,
      selectedOption: buildVehicleOption(),
      pricingPreview: buildPricingPreview(),
      extraction: { intent: "unknown" as const, draftPatch: {}, confidence: 0.5 },
    };

    expect(
      resolveRouteDecision(
        buildState({
          ...base,
          inboundInteractive: {
            type: "button",
            buttonId: BOOKING_AGENT_BUTTON_ID.RETRY_BOOKING,
          },
        }),
      ),
    ).toEqual({ nextAction: "create_booking" });
    expect(
      resolveRouteDecision(
        buildState({
          ...base,
          inboundInteractive: { type: "button", buttonId: BOOKING_AGENT_BUTTON_ID.AGENT },
        }),
      ),
    ).toEqual({ nextAction: "handoff" });
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
    expect(decision.nextAction).toBe("respond");
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
    expect(decision.nextAction).toBe("respond");
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
    expect(decision.nextAction).toBe("respond");
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
    expect(decision.nextAction).not.toBe("create_booking");
  });

  it("clears state for reset intent even when duration clarification is present", () => {
    const decision = resolveRouteDecision(
      buildState({
        extraction: {
          intent: "reset",
          draftPatch: {},
          clarificationPrompt:
            "Do you want a Day booking for 2 days, or a Night booking for 2 nights?",
          confidence: 1,
        },
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
    expect(decision.nextAction).toBe("search");
    expect(decision.stage).toBe("searching");
    expect(decision.selectedOption).toBeNull();
    expect(decision.availableOptions).toEqual([]);
    expect(decision.lastShownOptions).toEqual([]);
  });

  it("adds or skips the current add-on and can skip the rest", () => {
    const addon: PublicAddon = {
      id: "addon-wifi",
      code: "WIFI",
      name: "Wi-Fi",
      description: null,
      pricingUnit: "PER_BOOKING",
      unitPrice: 5000,
      currency: "NGN",
    };
    const seat: PublicAddon = {
      id: "addon-seat",
      code: "SEAT",
      name: "Seat",
      description: null,
      pricingUnit: "PER_LEG",
      unitPrice: 3000,
      currency: "NGN",
    };
    const base = {
      stage: "selecting_addons" as const,
      availableAddons: [addon, seat],
      selectedAddonIds: [] as string[],
      addonSelectionIndex: 0,
      selectedOption: buildVehicleOption(),
      extraction: { intent: "unknown" as const, draftPatch: {}, confidence: 0.5 },
    };

    expect(
      resolveRouteDecision(
        buildState({
          ...base,
          inboundInteractive: { type: "button", buttonId: "addon_add:addon-wifi" },
        }),
      ),
    ).toEqual({
      selectedAddonIds: ["addon-wifi"],
      addonSelectionIndex: 1,
      nextAction: "prepare_quote",
    });

    expect(
      resolveRouteDecision(
        buildState({
          ...base,
          inboundMessage: "skip",
          extraction: { intent: "unknown", draftPatch: {}, confidence: 0.5 },
        }),
      ),
    ).toEqual({
      selectedAddonIds: [],
      addonSelectionIndex: 1,
      nextAction: "prepare_quote",
    });

    expect(
      resolveRouteDecision(
        buildState({
          ...base,
          inboundInteractive: { type: "button", buttonId: BOOKING_AGENT_BUTTON_ID.ADDON_SKIP_ALL },
        }),
      ),
    ).toEqual({
      addonSelectionIndex: 2,
      nextAction: "prepare_quote",
    });
  });

  it("fails closed on a stale add-on button", () => {
    const addon: PublicAddon = {
      id: "addon-wifi",
      code: "WIFI",
      name: "Wi-Fi",
      description: null,
      pricingUnit: "PER_BOOKING",
      unitPrice: 5000,
      currency: "NGN",
    };
    const decision = resolveRouteDecision(
      buildState({
        stage: "selecting_addons",
        availableAddons: [addon],
        addonSelectionIndex: 0,
        inboundInteractive: { type: "button", buttonId: "addon_add:addon-old" },
        extraction: { intent: "unknown", draftPatch: {}, confidence: 0.5 },
      }),
    );

    expect(decision).toEqual({ nextAction: "respond" });
  });

  it("applies or skips fuel without accepting a custom amount", () => {
    const fuelState = {
      stage: "selecting_fuel" as const,
      selectedOption: buildVehicleOption(),
      pricingPreview: buildPricingPreview({ fuelUpgradeCost: 8000 }),
      extraction: { intent: "unknown" as const, draftPatch: {}, confidence: 0.5 },
    };

    expect(
      resolveRouteDecision(
        buildState({
          ...fuelState,
          inboundInteractive: { type: "button", buttonId: BOOKING_AGENT_BUTTON_ID.FUEL_APPLY },
        }),
      ),
    ).toEqual({ requiresFullTank: true, nextAction: "prepare_quote" });
    expect(resolveRouteDecision(buildState({ ...fuelState, inboundMessage: "skip" }))).toEqual({
      requiresFullTank: false,
      nextAction: "prepare_quote",
    });
    expect(resolveRouteDecision(buildState({ ...fuelState, inboundMessage: "5000" }))).toEqual({
      nextAction: "respond",
    });
  });

  it("applies the quoted credit balance or skips credits", () => {
    const creditState = {
      stage: "selecting_credits" as const,
      selectedOption: buildVehicleOption(),
      pricingPreview: buildPricingPreview({ creditsApplicable: 4000 }),
      extraction: { intent: "unknown" as const, draftPatch: {}, confidence: 0.5 },
    };

    expect(
      resolveRouteDecision(
        buildState({
          ...creditState,
          inboundInteractive: { type: "button", buttonId: BOOKING_AGENT_BUTTON_ID.CREDITS_APPLY },
        }),
      ),
    ).toEqual({ useCredits: 4000, nextAction: "prepare_quote" });
    expect(
      resolveRouteDecision(
        buildState({
          ...creditState,
          inboundInteractive: { type: "button", buttonId: BOOKING_AGENT_BUTTON_ID.CREDITS_SKIP },
        }),
      ),
    ).toEqual({ useCredits: 0, nextAction: "prepare_quote" });
    expect(
      resolveRouteDecision(buildState({ ...creditState, inboundMessage: "use 1000 credits" })),
    ).toEqual({ nextAction: "respond" });
  });

  it("fails closed when an interactive button does not belong to the current stage", () => {
    const staleConfirm = resolveRouteDecision(
      buildState({
        stage: "collecting",
        draft: { bookingType: "DAY" },
        inboundInteractive: { type: "button", buttonId: BOOKING_AGENT_BUTTON_ID.CONFIRM },
        extraction: { intent: "confirm", draftPatch: {}, confidence: 1 },
      }),
    );
    const staleFuel = resolveRouteDecision(
      buildState({
        stage: "awaiting_payment",
        inboundInteractive: { type: "button", buttonId: BOOKING_AGENT_BUTTON_ID.FUEL_APPLY },
        extraction: { intent: "unknown", draftPatch: {}, confidence: 0.5 },
      }),
    );

    expect(staleConfirm).toEqual({ nextAction: "respond" });
    expect(staleFuel).toEqual({ nextAction: "respond" });
  });

  it("routes change details only while confirming", () => {
    const extraction = {
      intent: "ask_question" as const,
      draftPatch: {},
      question: "What would you like to change?",
      confidence: 1,
    };
    const button = { type: "button" as const, buttonId: BOOKING_AGENT_BUTTON_ID.CHANGE_DETAILS };

    expect(
      resolveRouteDecision(
        buildState({
          stage: "confirming",
          selectedOption: buildVehicleOption(),
          pricingPreview: buildPricingPreview(),
          inboundInteractive: button,
          extraction,
        }),
      ),
    ).toEqual({ nextAction: "respond", stage: "confirming" });
    expect(
      resolveRouteDecision(
        buildState({
          stage: "collecting",
          draft: { bookingType: "DAY" },
          inboundInteractive: button,
          extraction,
        }),
      ),
    ).toEqual({ nextAction: "respond" });
  });

  it("cancels from the clarification button and keeps other stale buttons closed", () => {
    const clarification = {
      stage: "confirming" as const,
      inboundMessage: "cancel",
      selectedOption: buildVehicleOption(),
      extraction: { intent: "cancel" as const, draftPatch: {}, confidence: 0.6 },
    };

    expect(
      resolveRouteDecision(
        buildState({
          ...clarification,
          inboundInteractive: { type: "button", buttonId: BOOKING_AGENT_BUTTON_ID.CANCEL },
        }),
      ),
    ).toEqual({ nextAction: "respond", stage: "cancelled" });
    expect(
      resolveRouteDecision(
        buildState({
          ...clarification,
          inboundInteractive: { type: "button", buttonId: BOOKING_AGENT_BUTTON_ID.SHOW_OTHERS },
        }),
      ).stage,
    ).toBe("collecting");
    expect(
      resolveRouteDecision(
        buildState({
          ...clarification,
          inboundInteractive: { type: "button", buttonId: BOOKING_AGENT_BUTTON_ID.CONFIRM },
        }),
      ),
    ).toEqual({ nextAction: "respond" });
  });
});
