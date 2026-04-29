import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { CarNotAvailableException, CarNotFoundException } from "../../booking/booking.error";
import { BookingCreationService } from "../../booking/booking-creation.service";
import { DatabaseService } from "../../database/database.service";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import { WhatsAppPersistenceService } from "../whatsapp/whatsapp-persistence.service";
import { CreateBookingNode } from "./create-booking.node";
import { LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE } from "./langgraph.const";
import { buildVehicleOption } from "./langgraph.factory";
import { createDefaultLocationValidationState } from "./langgraph.interface";
import { LangGraphNodeState } from "./langgraph-node-state.interface";

function buildTestState(overrides: Partial<LangGraphNodeState> = {}): LangGraphNodeState {
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
    nextNode: null,
    error: null,
    statusMessage: null,
    locationValidation: createDefaultLocationValidationState(),
    ...overrides,
  };
}

describe("CreateBookingNode", () => {
  let moduleRef: TestingModule;
  let createBookingNode: CreateBookingNode;

  const bookingCreationServiceMock = {
    createBooking: vi.fn(),
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

    moduleRef = await Test.createTestingModule({
      providers: [
        CreateBookingNode,
        { provide: BookingCreationService, useValue: bookingCreationServiceMock },
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: BookingAgentSearchService, useValue: bookingAgentSearchServiceMock },
        { provide: WhatsAppPersistenceService, useValue: whatsAppPersistenceServiceMock },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    createBookingNode = moduleRef.get(CreateBookingNode);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  it("returns confirming error when selected option is missing", async () => {
    const result = await createBookingNode.run(buildTestState());

    expect(result.error).toBe("No vehicle selected for booking");
    expect(result.stage).toBe("confirming");
  });

  it("transitions to awaiting_payment when booking succeeds", async () => {
    databaseServiceMock.whatsAppConversation.findUnique.mockResolvedValue({
      phoneE164: "+2348012345678",
      profileName: "Test User",
    });
    bookingCreationServiceMock.createBooking.mockResolvedValue({
      bookingId: "booking_123",
      checkoutUrl: "https://pay.example.com/booking_123",
    });

    const result = await createBookingNode.run(
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
    expect(result.paymentLink).toBe("https://pay.example.com/booking_123");
    expect(bookingCreationServiceMock.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          guestEmail: "whatsapp.2348012345678@tripdly.com",
        }),
        sessionUser: null,
        context: { guestContactSource: "WHATSAPP_AGENT" },
      }),
    );
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
    bookingCreationServiceMock.createBooking.mockResolvedValue({
      bookingId: "booking_456",
      checkoutUrl: "https://pay.example.com/booking_456",
    });

    const result = await createBookingNode.run(
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

    const result = await createBookingNode.run(
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
    expect(result.error).not.toBe(LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE);
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

    const result = await createBookingNode.run(
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
    expect(result.error).not.toBe(LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE);
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

    const result = await createBookingNode.run(
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
    expect(result.error).toBe(LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE);
  });
});
