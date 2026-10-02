import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { buildPricingPreview, buildState, buildVehicleOption } from "./conversation.factory";
import { createDefaultLocationValidationState } from "./conversation.interface";
import { MergeAction } from "./merge.action";

describe("MergeAction", () => {
  let mergeAction: MergeAction;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [MergeAction],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    mergeAction = moduleRef.get(MergeAction);
  });

  it("applies extraction draft patch and clears stale options when draft changed", () => {
    const result = mergeAction.run({
      conversationId: "conv_1",
      inboundMessage: "pickup in Lekki",
      inboundMessageId: "msg_1",
      customerId: null,
      stage: "collecting",
      turnCount: 1,
      messages: [],
      draft: { pickupLocation: "Ikoyi" },
      availableOptions: [
        {
          id: "veh_1",
          make: "Toyota",
          model: "Prado",
          name: "Toyota Prado",
          color: "black",
          vehicleType: "SUV",
          serviceTier: "EXECUTIVE",
          imageUrl: null,
          rates: { day: 1, night: 1, fullDay: 1, airportPickup: 1 },
          estimatedTotalInclVat: 1,
        },
      ],
      lastShownOptions: [
        {
          id: "veh_shown",
          make: "Toyota",
          model: "Camry",
          name: "Toyota Camry",
          color: "white",
          vehicleType: "SEDAN",
          serviceTier: "EXECUTIVE",
          imageUrl: null,
          rates: { day: 1, night: 1, fullDay: 1, airportPickup: 1 },
          estimatedTotalInclVat: 1,
        },
      ],
      selectedOption: {
        id: "veh_1",
        make: "Toyota",
        model: "Prado",
        name: "Toyota Prado",
        color: "black",
        vehicleType: "SUV",
        serviceTier: "EXECUTIVE",
        imageUrl: null,
        rates: { day: 1, night: 1, fullDay: 1, airportPickup: 1 },
        estimatedTotalInclVat: 1,
      },
      holdId: null,
      holdExpiresAt: null,
      bookingId: null,
      paymentLink: null,
      preferences: {},
      response: null,
      outboxItems: [],
      extraction: {
        intent: "update_info",
        draftPatch: { pickupLocation: "Lekki" },
        confidence: 0.9,
      },
      nextAction: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.draft?.pickupLocation).toBe("Lekki");
    expect(result.availableOptions).toEqual([]);
    expect(result.selectedOption).toBeNull();
    expect(result.lastShownOptions).toEqual([]);
  });

  it("clears stale duration fields while asking for duration clarification", () => {
    const result = mergeAction.run(
      buildState({
        inboundMessage: "Night booking for 2 days",
        draft: {
          bookingType: "NIGHT",
          pickupDate: "2026-03-05",
          durationDays: 3,
          dropoffDate: "2026-03-08",
        },
        extraction: {
          intent: "provide_info",
          draftPatch: { bookingType: "NIGHT" },
          clarificationPrompt:
            "Do you want a Night booking for 2 nights, or a Day booking for 2 days?",
          confidence: 0.9,
        },
      }),
    );

    expect(result.draft?.durationDays).toBeUndefined();
    expect(result.draft?.dropoffDate).toBeUndefined();
  });

  it("uses pickup for an explicit same-location update but preserves a new destination", () => {
    const sameLocation = mergeAction.run(
      buildState({
        inboundMessage: "Actually, same as pickup",
        draft: {
          pickupLocation: "Mason Apartments, Ikoyi",
          dropoffLocation: "Lekki Phase 1",
        },
        extraction: {
          intent: "update_info",
          draftPatch: {},
          confidence: 0.9,
        },
      }),
    );
    expect(sameLocation.draft?.dropoffLocation).toBe("Mason Apartments, Ikoyi");

    const explicitDestination = mergeAction.run(
      buildState({
        inboundMessage: "Use Eko Hotel, not the same as pickup",
        draft: {
          pickupLocation: "Mason Apartments, Ikoyi",
          dropoffLocation: "Lekki Phase 1",
        },
        extraction: {
          intent: "update_info",
          draftPatch: { dropoffLocation: "Eko Hotel, Victoria Island" },
          confidence: 0.9,
        },
      }),
    );
    expect(explicitDestination.draft?.dropoffLocation).toBe("Eko Hotel, Victoria Island");
  });

  it("clears selectedOption when pickupTime or dropoffLocation changes", () => {
    const selected = buildVehicleOption();
    const timeChange = mergeAction.run(
      buildState({
        draft: {
          pickupLocation: "Ikoyi",
          dropoffLocation: "Lekki",
          pickupTime: "09:00",
        },
        selectedOption: selected,
        lastShownOptions: [selected],
        availableOptions: [selected],
        extraction: {
          intent: "update_info",
          draftPatch: { pickupTime: "10:00" },
          confidence: 0.9,
        },
      }),
    );

    expect(timeChange.draft?.pickupTime).toBe("10:00");
    expect(timeChange.selectedOption).toBeNull();
    expect(timeChange.lastShownOptions).toEqual([]);
    expect(timeChange.availableOptions).toEqual([]);

    const locationChange = mergeAction.run(
      buildState({
        draft: {
          pickupLocation: "Ikoyi",
          dropoffLocation: "Lekki",
          pickupTime: "09:00",
        },
        selectedOption: selected,
        lastShownOptions: [selected],
        availableOptions: [selected],
        extraction: {
          intent: "update_info",
          draftPatch: { dropoffLocation: "Victoria Island" },
          confidence: 0.9,
        },
      }),
    );

    expect(locationChange.draft?.dropoffLocation).toBe("Victoria Island");
    expect(locationChange.selectedOption).toBeNull();
    expect(locationChange.availableOptions).toEqual([]);
  });

  it("maps preference hints to budget/premium and appends notes without duplicates", () => {
    const result = mergeAction.run({
      conversationId: "conv_1",
      inboundMessage: "I want budget",
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
      preferences: { notes: ["budget"] },
      response: null,
      outboxItems: [],
      extraction: {
        intent: "provide_info",
        draftPatch: {},
        preferenceHint: "budget",
        confidence: 0.9,
      },
      nextAction: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.preferences?.pricePreference).toBe("budget");
    expect(result.preferences?.notes).toEqual(["budget"]);
  });

  it("invalidates the quote stage when a trip detail changes", () => {
    const result = mergeAction.run(
      buildState({
        stage: "selecting_fuel",
        draft: { pickupLocation: "Ikoyi", flightNumber: "BA74" },
        selectedOption: buildVehicleOption(),
        availableAddons: [],
        selectedAddonIds: ["addon-wifi"],
        addonSelectionIndex: 2,
        requiresFullTank: true,
        useCredits: 4000,
        pricingPreview: buildPricingPreview(),
        extraction: {
          intent: "update_info",
          draftPatch: { flightNumber: "BA100" },
          confidence: 0.9,
        },
      }),
    );

    expect(result.stage).toBe("collecting");
    expect(result.selectedOption).toBeNull();
    expect(result.availableOptions).toEqual([]);
    expect(result.selectedAddonIds).toEqual([]);
    expect(result.addonSelectionIndex).toBe(0);
    expect(result.requiresFullTank).toBe(false);
    expect(result.useCredits).toBe(0);
    expect(result.pricingPreview).toBeNull();
  });

  it("keeps the quote when a vehicle selection does not change the draft", () => {
    const result = mergeAction.run(
      buildState({
        stage: "presenting_options",
        draft: { make: "Toyota" },
        selectedOption: null,
        pricingPreview: buildPricingPreview(),
        extraction: {
          intent: "select_option",
          draftPatch: { make: "Toyota" },
          confidence: 1,
        },
      }),
    );

    expect(result.stage).toBe("presenting_options");
    expect(result.pricingPreview).toEqual(buildPricingPreview());
    expect(result.selectedOption).toBeNull();
  });
});
