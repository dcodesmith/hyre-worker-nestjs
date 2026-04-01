import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarNotAvailableException } from "../../booking/booking.error";
import { BookingCreationService } from "../../booking/booking-creation.service";
import { DatabaseService } from "../../database/database.service";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import { CreateBookingNode } from "./create-booking.node";
import { LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE } from "./langgraph.const";
import { buildVehicleOption } from "./langgraph.factory";
import { createDefaultLocationValidationState } from "./langgraph.interface";

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

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        CreateBookingNode,
        { provide: BookingCreationService, useValue: bookingCreationServiceMock },
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: BookingAgentSearchService, useValue: bookingAgentSearchServiceMock },
      ],
    }).compile();

    createBookingNode = moduleRef.get(CreateBookingNode);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  it("returns confirming error when selected option is missing", async () => {
    const result = await createBookingNode.run({
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
    });

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

    const result = await createBookingNode.run({
      conversationId: "conv_1",
      inboundMessage: "yes",
      inboundMessageId: "msg_1",
      customerId: null,
      stage: "confirming",
      turnCount: 1,
      messages: [],
      draft: {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
      },
      availableOptions: [],
      lastShownOptions: [],
      selectedOption: buildVehicleOption(),
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
    });

    expect(result.stage).toBe("awaiting_payment");
    expect(result.bookingId).toBe("booking_123");
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

    const result = await createBookingNode.run({
      conversationId: "conv_1",
      inboundMessage: "yes",
      inboundMessageId: "msg_1",
      customerId: null,
      stage: "confirming",
      turnCount: 1,
      messages: [],
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
    });

    expect(result.stage).toBe("presenting_options");
    expect(result.availableOptions?.[0]?.id).toBe("vehicle_alt_1");
    expect(result.error).not.toBe(LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE);
  });
});
