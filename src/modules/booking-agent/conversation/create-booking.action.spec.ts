import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  BookingFlightWindowChangedException,
  BookingPhoneVerificationRequiredException,
  BookingPriceChangedException,
  BookingRequestInProgressException,
  BookingValidationException,
  CarNotAvailableException,
  CarNotFoundException,
  IdempotencyKeyReusedException,
} from "../../booking/booking.error";
import { BookingCreationService } from "../../booking/booking-creation.service";
import { BookingPricingPreviewService } from "../../booking/booking-pricing-preview.service";
import { DatabaseService } from "../../database/database.service";
import { FlightNotFoundException } from "../../flightaware/flightaware.error";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import { WhatsAppPersistenceService } from "../whatsapp/whatsapp-persistence.service";
import { BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE } from "./conversation.const";
import { buildPricingPreview, buildVehicleOption } from "./conversation.factory";
import type { BookingAgentState } from "./conversation.interface";
import { createDefaultLocationValidationState } from "./conversation.interface";
import { CreateBookingAction } from "./create-booking.action";

function buildTestState(overrides: Partial<BookingAgentState> = {}): BookingAgentState {
  return {
    conversationId: "conv_1",
    inboundMessage: "yes",
    inboundMessageId: "msg_1",
    customerId: null,
    stage: "confirming",
    turnCount: 1,
    messages: [],
    draft: {},
    availableOptions: [],
    lastShownOptions: [],
    selectedOption: null,
    pricingPreview: buildPricingPreview(),
    holdId: null,
    holdExpiresAt: null,
    bookingId: null,
    paymentLink: null,
    preferences: {},
    response: null,
    outboxItems: [],
    extraction: null,
    nextAction: null,
    error: null,
    statusMessage: null,
    locationValidation: createDefaultLocationValidationState(),
    ...overrides,
  };
}

describe("CreateBookingAction", () => {
  let moduleRef: TestingModule;
  let createBookingAction: CreateBookingAction;

  const bookingCreationServiceMock = {
    createBooking: vi.fn(),
  };
  const bookingPricingPreviewServiceMock = {
    preview: vi.fn(),
  };
  const databaseServiceMock = {
    whatsAppConversation: {
      findUnique: vi.fn(),
    },
  };
  const bookingAgentSearchServiceMock = {
    searchVehiclesFromExtracted: vi.fn(),
  };
  const whatsAppPersistenceServiceMock = {
    getConversationLinkState: vi
      .fn()
      .mockResolvedValue({ linkedUserId: null, linkStatus: "UNLINKED" }),
  };

  beforeEach(async () => {
    databaseServiceMock.whatsAppConversation.findUnique.mockImplementation(() => {
      return Promise.resolve({
        phoneE164: "+2348012345678",
        profileName: "Test User",
      });
    });
    whatsAppPersistenceServiceMock.getConversationLinkState.mockResolvedValue({
      linkedUserId: null,
      linkStatus: "UNLINKED",
    });
    bookingPricingPreviewServiceMock.preview.mockResolvedValue({
      subtotalBeforeDiscounts: 150000,
      vatAmount: 0,
      totalAmount: 150000,
    });

    moduleRef = await Test.createTestingModule({
      providers: [
        CreateBookingAction,
        { provide: BookingCreationService, useValue: bookingCreationServiceMock },
        { provide: BookingPricingPreviewService, useValue: bookingPricingPreviewServiceMock },
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: BookingAgentSearchService, useValue: bookingAgentSearchServiceMock },
        { provide: WhatsAppPersistenceService, useValue: whatsAppPersistenceServiceMock },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    createBookingAction = moduleRef.get(CreateBookingAction);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  it("returns confirming error when selected option is missing", async () => {
    const result = await createBookingAction.run(buildTestState());

    expect(result.error).toBe("No vehicle selected for booking");
    expect(result.stage).toBe("confirming");
  });

  it("transitions to awaiting_payment when booking succeeds", async () => {
    databaseServiceMock.whatsAppConversation.findUnique.mockResolvedValue({
      phoneE164: "+2348012345678",
      profileName: "Test User",
    });
    const reservationExpiresAt = "2026-03-01T16:30:00.000Z";
    bookingCreationServiceMock.createBooking.mockResolvedValue({
      bookingId: "booking_123",
      checkoutUrl: "https://pay.example.com/booking_123",
      reservationExpiresAt,
    });

    const result = await createBookingAction.run(
      buildTestState({
        draft: {
          bookingType: "DAY",
          pickupDate: "2026-03-01",
          pickupTime: "09:00",
          dropoffDate: "2026-03-01",
          pickupLocation: "Victoria Island",
          dropoffLocation: "Lekki",
        },
        selectedOption: buildVehicleOption(),
      }),
    );

    expect(result.stage).toBe("awaiting_payment");
    expect(result.bookingId).toBe("booking_123");
    expect(result.holdId).toBe("booking_123");
    expect(result.holdExpiresAt).toBe(reservationExpiresAt);
    expect(result.paymentLink).toBe("https://pay.example.com/booking_123");
    expect(bookingCreationServiceMock.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          guestEmail: "whatsapp.2348012345678@tripdly.com",
          addonIds: [],
          requiresFullTank: false,
          useCredits: 0,
          expectedTotalAmount: "150000",
        }),
        sessionUser: null,
        context: {
          guestContactSource: "WHATSAPP_AGENT",
          requireFlightWindowConfirmation: true,
        },
      }),
    );
    expect(bookingPricingPreviewServiceMock.preview).toHaveBeenCalledWith(
      expect.objectContaining({ addonIds: [] }),
      null,
    );
  });

  it("requires confirmation when authoritative pricing differs from the displayed estimate", async () => {
    bookingPricingPreviewServiceMock.preview.mockResolvedValueOnce({
      subtotalBeforeDiscounts: 160000,
      vatAmount: 12000,
      totalAmount: 172000,
    });
    const selectedOption = buildVehicleOption({ estimatedTotalInclVat: 150000 });

    const result = await createBookingAction.run(
      buildTestState({
        draft: {
          bookingType: "DAY",
          pickupDate: "2026-03-01",
          pickupTime: "09:00",
          dropoffDate: "2026-03-01",
          pickupLocation: "Victoria Island",
          dropoffLocation: "Lekki",
        },
        selectedOption,
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        stage: "confirming",
        pricingPreview: expect.objectContaining({ totalAmount: 172000 }),
        statusMessage:
          "Pricing changed while you were confirming. Please review the updated quote.",
      }),
    );
    expect(result.selectedOption).toBeUndefined();
    expect(bookingCreationServiceMock.createBooking).not.toHaveBeenCalled();
  });

  it("keeps the confirmed quote when a later price change includes the new breakdown", async () => {
    const currentPricing = buildPricingPreview({ totalAmount: 172000, vatAmount: 12000 });
    bookingCreationServiceMock.createBooking.mockRejectedValue(
      new BookingPriceChangedException("150000", currentPricing),
    );

    const result = await createBookingAction.run(
      buildTestState({
        draft: {
          bookingType: "DAY",
          pickupDate: "2026-03-01",
          pickupTime: "09:00",
          dropoffDate: "2026-03-01",
          pickupLocation: "Victoria Island",
          dropoffLocation: "Lekki",
          notes: "Child seat",
        },
        selectedAddonIds: ["addon-wifi"],
        requiresFullTank: true,
        useCredits: 4000,
        selectedOption: buildVehicleOption(),
      }),
    );

    expect(bookingCreationServiceMock.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          addonIds: ["addon-wifi"],
          requiresFullTank: true,
          useCredits: 4000,
          specialRequests: "Child seat",
          expectedTotalAmount: "150000",
        }),
      }),
    );
    expect(result).toEqual({
      pricingPreview: currentPricing,
      error: null,
      stage: "confirming",
      statusMessage: "Pricing changed while you were confirming. Please review the updated quote.",
    });
  });

  it("asks the linked customer to verify their phone before booking", async () => {
    whatsAppPersistenceServiceMock.getConversationLinkState.mockResolvedValue({
      linkedUserId: "user-1",
      linkStatus: "LINKED",
    });
    bookingCreationServiceMock.createBooking.mockRejectedValue(
      new BookingPhoneVerificationRequiredException(),
    );

    const result = await createBookingAction.run(
      buildTestState({
        draft: {
          bookingType: "DAY",
          pickupDate: "2026-03-01",
          pickupTime: "09:00",
          dropoffDate: "2026-03-01",
          pickupLocation: "Victoria Island",
          dropoffLocation: "Lekki",
        },
        selectedOption: buildVehicleOption(),
      }),
    );

    expect(result).toEqual({
      error:
        "Verify your phone number in your Tripdly account settings, then return here and try again.",
      statusMessage: null,
      stage: "confirming",
    });
  });

  it("refuses to create a booking before the final quote exists", async () => {
    const result = await createBookingAction.run(
      buildTestState({
        pricingPreview: null,
        selectedOption: buildVehicleOption(),
        draft: { bookingType: "DAY", pickupDate: "2026-03-01" },
      }),
    );

    expect(result).toEqual({
      error: "The final quote is not ready yet. Please try again.",
      stage: "confirming",
    });
    expect(bookingCreationServiceMock.createBooking).not.toHaveBeenCalled();
  });

  it("returns an explicit retry response while the booking request is processing", async () => {
    bookingCreationServiceMock.createBooking.mockRejectedValue(
      new BookingRequestInProgressException(5),
    );

    const result = await createBookingAction.run(
      buildTestState({
        draft: {
          bookingType: "DAY",
          pickupDate: "2026-03-01",
          pickupTime: "09:00",
          dropoffDate: "2026-03-01",
          pickupLocation: "Victoria Island",
          dropoffLocation: "Lekki",
        },
        selectedOption: buildVehicleOption(),
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        error: null,
        stage: "confirming",
        statusMessage: expect.stringContaining("still being processed"),
      }),
    );
    expect(result.error).not.toBe(BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE);
  });

  it("returns an explicit conflict response when the message key has different input", async () => {
    bookingCreationServiceMock.createBooking.mockRejectedValue(new IdempotencyKeyReusedException());

    const result = await createBookingAction.run(
      buildTestState({
        draft: {
          bookingType: "DAY",
          pickupDate: "2026-03-01",
          pickupTime: "09:00",
          dropoffDate: "2026-03-01",
          pickupLocation: "Victoria Island",
          dropoffLocation: "Lekki",
        },
        selectedOption: buildVehicleOption(),
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        error: null,
        stage: "confirming",
        statusMessage: expect.stringContaining("details changed"),
      }),
    );
    expect(result.error).not.toBe(BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE);
  });

  it("creates booking as linked user when conversation is verified-linked", async () => {
    databaseServiceMock.whatsAppConversation.findUnique.mockResolvedValueOnce({
      phoneE164: "+2348012345678",
      profileName: "Test User",
    });
    whatsAppPersistenceServiceMock.getConversationLinkState.mockResolvedValueOnce({
      linkedUserId: "user_linked_123",
      linkStatus: "LINKED",
    });
    const reservationExpiresAt = "2026-03-02T16:30:00.000Z";
    bookingCreationServiceMock.createBooking.mockResolvedValue({
      bookingId: "booking_456",
      checkoutUrl: "https://pay.example.com/booking_456",
      reservationExpiresAt,
    });

    const result = await createBookingAction.run(
      buildTestState({
        customerId: "user_linked_123",
        draft: {
          bookingType: "DAY",
          pickupDate: "2026-03-01",
          pickupTime: "09:00",
          dropoffDate: "2026-03-01",
          pickupLocation: "Victoria Island",
          dropoffLocation: "Lekki",
        },
        selectedOption: buildVehicleOption(),
      }),
    );

    expect(result.stage).toBe("awaiting_payment");
    expect(result.bookingId).toBe("booking_456");
    expect(result.holdId).toBe("booking_456");
    expect(result.holdExpiresAt).toBe(reservationExpiresAt);
    expect(result.paymentLink).toBe("https://pay.example.com/booking_456");
    expect(bookingCreationServiceMock.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.any(Object),
        sessionUser: expect.objectContaining({ id: "user_linked_123" }),
      }),
    );
    expect(bookingCreationServiceMock.createBooking.mock.calls[0]?.[0]?.input).not.toHaveProperty(
      "guestEmail",
    );
  });

  it("returns alternatives when selected car is unavailable", async () => {
    const selected = buildVehicleOption({ id: "vehicle_unavailable" });
    const alternative = buildVehicleOption({ id: "vehicle_alt_1" });
    databaseServiceMock.whatsAppConversation.findUnique.mockResolvedValue({
      phoneE164: "+2348012345678",
      profileName: "Test User",
    });
    bookingCreationServiceMock.createBooking.mockRejectedValue(
      new CarNotAvailableException(selected.id, "Car Not Available Exception"),
    );
    bookingAgentSearchServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
      exactMatches: [alternative],
      alternatives: [],
      precondition: null,
    });

    const result = await createBookingAction.run(
      buildTestState({
        draft: {
          bookingType: "FULL_DAY",
          pickupDate: "2026-03-01",
          pickupTime: "09:00",
          dropoffDate: "2026-03-02",
          pickupLocation: "Victoria Island",
          dropoffLocation: "Lekki",
        },
        availableOptions: [selected],
        lastShownOptions: [selected],
        selectedOption: selected,
      }),
    );

    expect(result.stage).toBe("presenting_options");
    expect(result.availableOptions?.[0]?.id).toBe("vehicle_alt_1");
    expect(result.error).not.toBe(BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE);
    expect(bookingAgentSearchServiceMock.searchVehiclesFromExtracted).toHaveBeenCalledWith(
      expect.any(Object),
      "",
      selected.id,
    );
  });

  it("returns alternatives when selected car is not found", async () => {
    const selected = buildVehicleOption({ id: "vehicle_deleted" });
    const alternative = buildVehicleOption({ id: "vehicle_alt_2" });
    databaseServiceMock.whatsAppConversation.findUnique.mockResolvedValue({
      phoneE164: "+2348012345678",
      profileName: "Test User",
    });
    bookingCreationServiceMock.createBooking.mockRejectedValue(
      new CarNotFoundException(selected.id),
    );
    bookingAgentSearchServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
      exactMatches: [alternative],
      alternatives: [],
      precondition: null,
    });

    const result = await createBookingAction.run(
      buildTestState({
        draft: {
          bookingType: "FULL_DAY",
          pickupDate: "2026-03-01",
          pickupTime: "09:00",
          dropoffDate: "2026-03-02",
          pickupLocation: "Victoria Island",
          dropoffLocation: "Lekki",
        },
        availableOptions: [selected],
        lastShownOptions: [selected],
        selectedOption: selected,
      }),
    );

    expect(result.stage).toBe("presenting_options");
    expect(result.availableOptions?.[0]?.id).toBe("vehicle_alt_2");
    expect(result.error).not.toBe(BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE);
    expect(bookingAgentSearchServiceMock.searchVehiclesFromExtracted).toHaveBeenCalledWith(
      expect.any(Object),
      "",
      selected.id,
    );
  });

  it("returns service unavailable fallback when booking fails with generic error", async () => {
    const selected = buildVehicleOption({ id: "vehicle_selected" });
    databaseServiceMock.whatsAppConversation.findUnique.mockResolvedValue({
      phoneE164: "+2348012345678",
      profileName: "Test User",
    });
    bookingCreationServiceMock.createBooking.mockRejectedValue(
      new Error("Generic booking failure"),
    );

    const result = await createBookingAction.run(
      buildTestState({
        stage: "confirming",
        draft: {
          bookingType: "FULL_DAY",
          pickupDate: "2026-03-01",
          pickupTime: "09:00",
          dropoffDate: "2026-03-02",
          pickupLocation: "Victoria Island",
          dropoffLocation: "Lekki",
        },
        availableOptions: [selected],
        lastShownOptions: [selected],
        selectedOption: selected,
      }),
    );

    expect(result.stage).toBe("confirming");
    expect(result.availableOptions).toBeUndefined();
    expect(result.lastShownOptions).toBeUndefined();
    expect(result.error).toBe(BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE);
  });

  it("asks for confirmation when refreshed flight times change", async () => {
    const selected = buildVehicleOption();
    bookingCreationServiceMock.createBooking.mockRejectedValue(
      new BookingFlightWindowChangedException(
        new Date("2026-03-02T00:10:00.000Z"),
        new Date("2026-03-02T01:22:00.000Z"),
      ),
    );

    const result = await createBookingAction.run(
      buildTestState({
        selectedOption: selected,
        draft: {
          bookingType: "AIRPORT_PICKUP",
          pickupDate: "2026-03-01",
          pickupDateTime: "2026-03-01T23:40:00.000Z",
          pickupTime: "00:40",
          pickupLocation: "Murtala Muhammed International Airport, Lagos",
          dropoffDate: "2026-03-02",
          dropoffDateTime: "2026-03-02T00:52:00.000Z",
          dropoffLocation: "Victoria Island",
          flightNumber: "BA74",
          vehicleType: "SUV",
        },
      }),
    );

    expect(result.stage).toBe("confirming");
    expect(result.error).toBeNull();
    expect(result.draft).toMatchObject({
      pickupDate: "2026-03-01",
      pickupDateTime: "2026-03-02T00:10:00.000Z",
      pickupTime: "01:10",
      dropoffDate: "2026-03-02",
      dropoffDateTime: "2026-03-02T01:22:00.000Z",
    });
    expect(result.statusMessage).toContain("Pickup is now Mar 2, 2026 at 1:10 AM");
    expect(result.statusMessage).toContain("Please confirm the updated booking times.");
    expect(bookingCreationServiceMock.createBooking.mock.calls[0]?.[0]?.input.flightDate).toBe(
      "2026-03-01",
    );
  });

  it("returns airport flight and validation failures to collecting", async () => {
    const flightError = new FlightNotFoundException("BA74", "2026-03-01");
    const validationError = new BookingValidationException([
      {
        field: "sameLocation",
        message: "Airport pickup bookings require a different drop-off location",
      },
    ]);
    const selected = buildVehicleOption();
    const airportDraft = {
      bookingType: "AIRPORT_PICKUP" as const,
      pickupDate: "2026-03-01",
      pickupDateTime: "2026-03-01T14:40:00.000Z",
      dropoffDateTime: "2026-03-01T15:54:00.000Z",
      pickupTime: "15:40",
      pickupLocation: "Murtala Muhammed International Airport, Lagos",
      dropoffDate: "2026-03-01",
      dropoffLocation: "Victoria Island",
      flightNumber: "BA74",
      vehicleType: "SUV" as const,
    };

    bookingCreationServiceMock.createBooking.mockRejectedValueOnce(flightError);
    const flightResult = await createBookingAction.run(
      buildTestState({
        selectedOption: selected,
        availableOptions: [selected],
        lastShownOptions: [selected],
        requiresFullTank: true,
        useCredits: 5000,
        pricingPreview: buildPricingPreview(),
        draft: airportDraft,
      }),
    );

    bookingCreationServiceMock.createBooking.mockRejectedValueOnce(validationError);
    const validationResult = await createBookingAction.run(
      buildTestState({
        selectedOption: selected,
        requiresFullTank: true,
        useCredits: 5000,
        pricingPreview: buildPricingPreview(),
        draft: airportDraft,
      }),
    );

    for (const result of [flightResult, validationResult]) {
      expect(result.stage).toBe("collecting");
      expect(result.error).toBeNull();
      expect(result.selectedOption).toBeNull();
      expect(result.pricingPreview).toBeNull();
      expect(result.availableOptions).toEqual([]);
      expect(result.requiresFullTank).toBe(false);
      expect(result.useCredits).toBe(0);
      expect(result.draft?.flightNumber).toBe("BA74");
      expect(result.draft?.pickupTime).toBeUndefined();
      expect(result.draft?.pickupLocation).toBeUndefined();
      expect(result.draft?.pickupDateTime).toBeUndefined();
      expect(result.draft?.dropoffDate).toBeUndefined();
      expect(result.draft?.dropoffDateTime).toBeUndefined();
      expect(result.statusMessage).not.toMatch(/pickup time|pickup address|airport address/i);
    }
    expect(flightResult.statusMessage).toBe(flightError.message);
    expect(validationResult.statusMessage).toBe(
      "Airport pickup bookings require a different drop-off location",
    );
  });

  it("asks to revalidate the flight when derived airport times are missing", async () => {
    const result = await createBookingAction.run(
      buildTestState({
        selectedOption: buildVehicleOption(),
        pricingPreview: buildPricingPreview(),
        draft: {
          bookingType: "AIRPORT_PICKUP",
          pickupDate: "2026-03-01",
          flightNumber: "BA74",
          dropoffLocation: "Victoria Island",
          pickupLocation: "stale airport address",
          pickupDateTime: "2026-03-01T14:40:00.000Z",
        },
      }),
    );

    expect(bookingCreationServiceMock.createBooking).not.toHaveBeenCalled();
    expect(result.stage).toBe("collecting");
    expect(result.error).toBeNull();
    expect(result.selectedOption).toBeNull();
    expect(result.pricingPreview).toBeNull();
    expect(result.statusMessage).toBe(
      "I need to validate your flight again. Please confirm the flight number and flight date.",
    );
    expect(result.draft?.pickupLocation).toBeUndefined();
    expect(result.draft?.pickupDateTime).toBeUndefined();
  });
});
