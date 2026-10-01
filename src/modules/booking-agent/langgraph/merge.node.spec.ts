import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { buildState, buildVehicleOption } from "./langgraph.factory";
import { createDefaultLocationValidationState } from "./langgraph.interface";
import { MergeNode } from "./merge.node";

describe("MergeNode", () => {
  let mergeNode: MergeNode;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [MergeNode],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    mergeNode = moduleRef.get(MergeNode);
  });

  it("applies extraction draft patch and clears stale options when draft changed", () => {
    const result = mergeNode.run({
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
      nextNode: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.draft?.pickupLocation).toBe("Lekki");
    expect(result.availableOptions).toEqual([]);
    expect(result.selectedOption).toBeNull();
    expect(result.lastShownOptions).toEqual([]);
  });

  it("clears selectedOption when pickupTime or dropoffLocation changes", () => {
    const selected = buildVehicleOption();
    const timeChange = mergeNode.run(
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

    const locationChange = mergeNode.run(
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
    const result = mergeNode.run({
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
      nextNode: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.preferences?.pricePreference).toBe("budget");
    expect(result.preferences?.notes).toEqual(["budget"]);
  });
});
