import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  BookingRequestInProgressException,
  CarNotAvailableException,
  CarNotFoundException,
  IdempotencyKeyReusedException,
} from "../../booking/booking.error";
import { BookingCreationService } from "../../booking/booking-creation.service";
import { BookingPricingPreviewService } from "../../booking/booking-pricing-preview.service";
import { DatabaseService } from "../../database/database.service";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import { WhatsAppPersistenceService } from "../whatsapp/whatsapp-persistence.service";
import { CreateBookingAction } from "./create-booking.action";
import { BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE } from "./conversation.const";
import { buildVehicleOption } from "./conversation.factory";
import { createDefaultLocationValidationState } from "./conversation.interface";
import type { BookingAgentState } from "./conversation.interface";

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
        }),
        sessionUser: null,
        context: { guestContactSource: "WHATSAPP_AGENT" },
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
        selectedOption: expect.objectContaining({ estimatedTotalInclVat: 172000 }),
        statusMessage: expect.stringContaining("₦172,000"),
      }),
    );
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
});
