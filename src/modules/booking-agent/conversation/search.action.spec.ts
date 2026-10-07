import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { BookingLegService } from "../../booking/booking-leg.service";
import { FlightNotFoundException } from "../../flightaware/flightaware.error";
import { FlightAwareService } from "../../flightaware/flightaware.service";
import { GooglePlacesService } from "../../maps/google-places.service";
import { MapsService } from "../../maps/maps.service";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import { buildState, buildVehicleOption } from "./conversation.factory";
import { createDefaultLocationValidationState } from "./conversation.interface";
import { SearchAction } from "./search.action";

describe("SearchAction", () => {
  let moduleRef: TestingModule;
  let searchAction: SearchAction;

  const bookingAgentSearchServiceMock = {
    searchVehiclesFromExtracted: vi.fn(),
  };
  const googlePlacesServiceMock = {
    validateAddress: vi.fn(),
  };
  const flightAwareServiceMock = {
    searchAirportPickupFlight: vi.fn(),
  };
  const mapsServiceMock = {
    calculateAirportTripDuration: vi.fn(),
  };
  const bookingLegServiceMock = {
    generateLegs: vi.fn(
      (input: { flightArrivalTime?: Date; startDate: Date; driveTimeMinutes?: number }) => {
        const start = input.flightArrivalTime
          ? new Date(input.flightArrivalTime.getTime() + 40 * 60 * 1000)
          : new Date(input.startDate);
        const driveMinutes = Math.ceil((input.driveTimeMinutes ?? 120) * 1.2);
        const end = new Date(start.getTime() + driveMinutes * 60 * 1000);
        return [{ legDate: start, legStartTime: start, legEndTime: end }];
      },
    ),
  };

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        SearchAction,
        { provide: BookingAgentSearchService, useValue: bookingAgentSearchServiceMock },
        { provide: GooglePlacesService, useValue: googlePlacesServiceMock },
        { provide: FlightAwareService, useValue: flightAwareServiceMock },
        { provide: MapsService, useValue: mapsServiceMock },
        { provide: BookingLegService, useValue: bookingLegServiceMock },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    searchAction = moduleRef.get(SearchAction);
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

    const result = await searchAction.run({
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

    expect(bookingAgentSearchServiceMock.searchVehiclesFromExtracted).not.toHaveBeenCalled();
    expect(result.outboxItems?.[0]?.dedupeKey).toContain(":address-checking");
    expect(result.stage).toBe("collecting");
  });

  it("searches without a vehicleType filter when the draft uses ANY", async () => {
    googlePlacesServiceMock.validateAddress.mockResolvedValue({
      isValid: true,
      normalizedAddress: "Victoria Island, Lagos, Nigeria",
    });
    bookingAgentSearchServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
      exactMatches: [
        buildVehicleOption({ id: "sedan_1", vehicleType: "SEDAN" }),
        buildVehicleOption({ id: "suv_1", vehicleType: "SUV" }),
      ],
      alternatives: [],
    });

    const result = await searchAction.run({
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
        vehicleType: "ANY",
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
        intent: "provide_info",
        draftPatch: { vehicleType: "ANY" },
        confidence: 1,
      },
      nextAction: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    const [searchParams] = bookingAgentSearchServiceMock.searchVehiclesFromExtracted.mock.calls[0];
    expect(searchParams.vehicleType).toBeUndefined();
    expect(result.stage).toBe("presenting_options");
    expect(result.availableOptions).toHaveLength(2);
    expect(result.statusMessage).toBeNull();
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

    const result = await searchAction.run({
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
      nextAction: null,
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

  it("derives the airport window from the flight and normalized dropoff", async () => {
    const normalizedDropoff = "Victoria Island, Lagos, Nigeria";
    const warning = "Schedule shifted by 15 minutes.";
    googlePlacesServiceMock.validateAddress.mockResolvedValue({
      isValid: true,
      normalizedAddress: normalizedDropoff,
    });
    flightAwareServiceMock.searchAirportPickupFlight.mockResolvedValue({
      warning,
      flight: {
        flightNumber: "BA74",
        flightId: "BA74-1",
        origin: "EGLL",
        destination: "DNMM",
        destinationName: "Murtala Muhammed International Airport",
        destinationCity: "Lagos",
        scheduledDeparture: "2026-03-01T08:00:00.000Z",
        scheduledArrival: "2026-03-01T14:00:00.000Z",
        arrivalTime: "2026-03-01T14:00:00.000Z",
        arrivalTimeSource: "estimated",
        isLive: true,
      },
    });
    mapsServiceMock.calculateAirportTripDuration.mockResolvedValue({
      durationMinutes: 61,
      distanceMeters: 18000,
      isEstimate: false,
    });
    bookingAgentSearchServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
      exactMatches: [buildVehicleOption()],
      alternatives: [],
    });

    const result = await searchAction.run(
      buildState({
        draft: {
          bookingType: "AIRPORT_PICKUP",
          pickupDate: "2026-03-01",
          flightNumber: "BA74",
          vehicleType: "SUV",
          dropoffLocation: "VI raw address",
          pickupLocation: "stale airport address",
          pickupTime: "09:00",
          pickupDateTime: "2026-03-01T09:00:00.000Z",
          dropoffDate: "2026-03-02",
          dropoffDateTime: "2026-03-02T12:00:00.000Z",
          durationDays: 2,
        },
      }),
    );

    expect(googlePlacesServiceMock.validateAddress).toHaveBeenCalledTimes(1);
    expect(googlePlacesServiceMock.validateAddress).toHaveBeenCalledWith("VI raw address");
    expect(googlePlacesServiceMock.validateAddress.mock.invocationCallOrder[0]).toBeLessThan(
      mapsServiceMock.calculateAirportTripDuration.mock.invocationCallOrder[0],
    );
    expect(flightAwareServiceMock.searchAirportPickupFlight).toHaveBeenCalledWith(
      "BA74",
      "2026-03-01",
    );
    expect(mapsServiceMock.calculateAirportTripDuration).toHaveBeenCalledWith(normalizedDropoff);
    expect(bookingLegServiceMock.generateLegs).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingType: "AIRPORT_PICKUP",
        flightArrivalTime: new Date("2026-03-01T14:00:00.000Z"),
        driveTimeMinutes: 61,
      }),
    );
    expect(result.draft).toEqual(
      expect.objectContaining({
        pickupDateTime: "2026-03-01T14:40:00.000Z",
        dropoffDateTime: "2026-03-01T15:54:00.000Z",
        pickupTime: "15:40",
        pickupLocation: "Murtala Muhammed International Airport, Lagos",
        dropoffDate: "2026-03-01",
        dropoffLocation: normalizedDropoff,
      }),
    );
    expect(result.draft?.durationDays).toBeUndefined();
    expect(result.locationValidation?.pickup).toEqual({
      status: "valid",
      lastValidatedInput: "Murtala Muhammed International Airport, Lagos",
      normalizedAddress: "Murtala Muhammed International Airport, Lagos",
    });
    expect(result.statusMessage).toBe(
      `${warning} Flight BA74 arrives in Lagos at 3:00 PM. Pickup will be around 3:40 PM from Murtala Muhammed International Airport, Lagos.`,
    );
    expect(bookingAgentSearchServiceMock.searchVehiclesFromExtracted).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "2026-03-01T14:40:00.000Z",
        to: "2026-03-01T15:54:00.000Z",
      }),
      "",
    );
    expect(result.stage).toBe("presenting_options");
  });

  it("asks for a complete dropoff address and does not call FlightAware or Maps", async () => {
    googlePlacesServiceMock.validateAddress.mockResolvedValue({
      isValid: false,
      failureReason: "AREA_ONLY",
    });

    const result = await searchAction.run(
      buildState({
        draft: {
          bookingType: "AIRPORT_PICKUP",
          pickupDate: "2026-03-01",
          flightNumber: "BA74",
          vehicleType: "SUV",
          dropoffLocation: "Ikoyi",
          pickupLocation: "stale airport address",
        },
      }),
    );

    expect(googlePlacesServiceMock.validateAddress).toHaveBeenCalledTimes(1);
    expect(googlePlacesServiceMock.validateAddress).toHaveBeenCalledWith("Ikoyi");
    expect(flightAwareServiceMock.searchAirportPickupFlight).not.toHaveBeenCalled();
    expect(mapsServiceMock.calculateAirportTripDuration).not.toHaveBeenCalled();
    expect(result.stage).toBe("collecting");
    expect(result.response?.text).toContain("drop-off address");
    expect(result.response?.text).not.toContain("pickup address");
  });

  it("returns the exact FlightAware error and clears derived airport fields", async () => {
    const flightError = new FlightNotFoundException("BA74", "2026-03-01");
    googlePlacesServiceMock.validateAddress.mockResolvedValue({
      isValid: true,
      normalizedAddress: "Victoria Island, Lagos, Nigeria",
    });
    flightAwareServiceMock.searchAirportPickupFlight.mockRejectedValue(flightError);

    const result = await searchAction.run(
      buildState({
        draft: {
          bookingType: "AIRPORT_PICKUP",
          pickupDate: "2026-03-01",
          flightNumber: "BA74",
          vehicleType: "SUV",
          dropoffLocation: "Victoria Island",
          pickupLocation: "stale airport address",
          pickupTime: "09:00",
          pickupDateTime: "2026-03-01T09:00:00.000Z",
          dropoffDate: "2026-03-01",
          dropoffDateTime: "2026-03-01T12:00:00.000Z",
        },
      }),
    );

    expect(mapsServiceMock.calculateAirportTripDuration).not.toHaveBeenCalled();
    expect(result.stage).toBe("collecting");
    expect(result.error).toBeNull();
    expect(result.statusMessage).toBe(flightError.message);
    expect(result.draft?.flightNumber).toBe("BA74");
    expect(result.draft?.dropoffLocation).toBe("Victoria Island, Lagos, Nigeria");
    expect(result.draft?.pickupTime).toBeUndefined();
    expect(result.draft?.pickupLocation).toBeUndefined();
    expect(result.draft?.pickupDateTime).toBeUndefined();
    expect(result.draft?.dropoffDate).toBeUndefined();
    expect(result.draft?.dropoffDateTime).toBeUndefined();
  });
});
