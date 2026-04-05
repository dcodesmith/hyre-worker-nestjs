import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GooglePlacesService } from "../../maps/google-places.service";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import { createDefaultLocationValidationState } from "./langgraph.interface";
import { SearchNode } from "./search.node";

describe("SearchNode", () => {
  let moduleRef: TestingModule;
  let searchNode: SearchNode;

  const bookingAgentSearchServiceMock = {
    searchVehiclesFromExtracted: vi.fn(),
  };
  const googlePlacesServiceMock = {
    validateAddress: vi.fn(),
  };

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        SearchNode,
        { provide: BookingAgentSearchService, useValue: bookingAgentSearchServiceMock },
        { provide: GooglePlacesService, useValue: googlePlacesServiceMock },
      ],
    }).compile();

    searchNode = moduleRef.get(SearchNode);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  it("returns pickup clarification outbox when pickup validation fails", async () => {
    googlePlacesServiceMock.validateAddress.mockResolvedValue({
      isValid: false,
      failureReason: "AREA_ONLY",
    });

    const result = await searchNode.run({
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

    expect(bookingAgentSearchServiceMock.searchVehiclesFromExtracted).not.toHaveBeenCalled();
    expect(result.outboxItems?.[0]?.dedupeKey).toContain(":address-checking");
    expect(result.stage).toBe("collecting");
  });

  it("returns presenting_options when search has exact matches", async () => {
    googlePlacesServiceMock.validateAddress.mockResolvedValue({
      isValid: true,
      normalizedAddress: "Victoria Island, Lagos, Nigeria",
    });
    bookingAgentSearchServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
      exactMatches: [
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
          estimatedTotalInclVat: 120000,
        },
      ],
      alternatives: [],
    });

    const result = await searchNode.run({
      conversationId: "conv_1",
      inboundMessage: "search",
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
        vehicleType: "SUV",
        make: "Toyota",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Victoria Island",
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
        intent: "confirm",
        draftPatch: {},
        confidence: 0.9,
      },
      nextNode: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(bookingAgentSearchServiceMock.searchVehiclesFromExtracted).toHaveBeenCalledTimes(1);
    expect(bookingAgentSearchServiceMock.searchVehiclesFromExtracted).toHaveBeenCalledWith(
      expect.objectContaining({
        vehicleType: "SUV",
        make: "Toyota",
      }),
      "",
    );
    expect(result.stage).toBe("presenting_options");
    expect(result.availableOptions).toHaveLength(1);
  });
});
