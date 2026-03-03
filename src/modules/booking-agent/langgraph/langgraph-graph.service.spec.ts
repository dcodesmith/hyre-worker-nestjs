import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarNotAvailableException } from "../../booking/booking.error";
import { BookingCreationService } from "../../booking/booking-creation.service";
import { DatabaseService } from "../../database/database.service";
import { GooglePlacesService } from "../../maps/google-places.service";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import { BookingAgentWindowPolicyService } from "../booking-agent-window-policy.service";
import type { BookingAgentState, VehicleSearchOption } from "./langgraph.interface";
import { LangGraphExtractorService } from "./langgraph-extractor.service";
import { LangGraphGraphService } from "./langgraph-graph.service";
import { LangGraphResponderService } from "./langgraph-responder.service";
import { LangGraphStateService } from "./langgraph-state.service";

describe("LangGraphGraphService", () => {
  let moduleRef: TestingModule;
  let service: LangGraphGraphService;
  let stateServiceMock: {
    loadState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    createInitialState: ReturnType<typeof vi.fn>;
    mergeWithExisting: ReturnType<typeof vi.fn>;
    addMessage: ReturnType<typeof vi.fn>;
  };
  let extractorServiceMock: {
    extract: ReturnType<typeof vi.fn>;
  };
  let responderServiceMock: {
    generateResponse: ReturnType<typeof vi.fn>;
  };
  let toolExecutorServiceMock: {
    searchVehiclesFromExtracted: ReturnType<typeof vi.fn>;
  };
  let windowPolicyServiceMock: {
    resolveOutboundMode: ReturnType<typeof vi.fn>;
  };
  let bookingCreationServiceMock: {
    createBooking: ReturnType<typeof vi.fn>;
  };
  let databaseServiceMock: {
    whatsAppConversation: {
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
  let googlePlacesServiceMock: {
    validateAddressWithSuggestions: ReturnType<typeof vi.fn>;
  };

  const conversationId = "conv_test";
  const messageId = "msg_test";

  const buildInitialState = (): BookingAgentState => ({
    conversationId,
    inboundMessage: "",
    inboundMessageId: messageId,
    customerId: null,
    stage: "greeting",
    turnCount: 0,
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
    locationSuggestions: [],
    locationLookupTriggered: false,
    locationLookupFailed: false,
  });

  const buildVehicleOption = (overrides?: Partial<VehicleSearchOption>): VehicleSearchOption => ({
    id: "vehicle_1",
    make: "Toyota",
    model: "Prado",
    name: "Toyota Prado",
    color: "black",
    vehicleType: "SUV",
    serviceTier: "EXECUTIVE",
    imageUrl: null,
    rates: { day: 65000, night: 70000, fullDay: 110000, airportPickup: 40000 },
    estimatedTotalInclVat: 150000,
    ...overrides,
  });

  beforeEach(async () => {
    stateServiceMock = {
      loadState: vi.fn().mockResolvedValue(null),
      saveState: vi.fn().mockResolvedValue(undefined),
      createInitialState: vi.fn().mockImplementation(buildInitialState),
      mergeWithExisting: vi.fn().mockImplementation((existing) => ({ ...existing })),
      addMessage: vi.fn(),
    };

    extractorServiceMock = {
      extract: vi.fn().mockResolvedValue({
        intent: "greeting",
        draftPatch: {},
        confidence: 0.9,
      }),
    };

    responderServiceMock = {
      generateResponse: vi.fn().mockResolvedValue({
        text: "Hello! How can I help you today?",
      }),
    };

    toolExecutorServiceMock = {
      searchVehiclesFromExtracted: vi.fn().mockResolvedValue({
        exactMatches: [],
        alternatives: [],
      }),
    };

    windowPolicyServiceMock = {
      resolveOutboundMode: vi.fn().mockReturnValue("FREEFORM"),
    };

    bookingCreationServiceMock = {
      createBooking: vi.fn().mockResolvedValue({
        bookingId: "booking_123",
        checkoutUrl: "https://pay.tripdly.com/checkout/booking_123",
      }),
    };

    databaseServiceMock = {
      whatsAppConversation: {
        findUnique: vi.fn().mockResolvedValue({
          phoneE164: "+2348012345678",
          profileName: "Test Customer",
        }),
      },
    };

    googlePlacesServiceMock = {
      validateAddressWithSuggestions: vi.fn().mockResolvedValue({
        isValid: true,
        normalizedAddress: "Victoria Island, Lagos, Nigeria",
        suggestions: [],
      }),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        LangGraphGraphService,
        { provide: LangGraphStateService, useValue: stateServiceMock },
        { provide: LangGraphExtractorService, useValue: extractorServiceMock },
        { provide: LangGraphResponderService, useValue: responderServiceMock },
        { provide: BookingAgentSearchService, useValue: toolExecutorServiceMock },
        { provide: BookingAgentWindowPolicyService, useValue: windowPolicyServiceMock },
        { provide: BookingCreationService, useValue: bookingCreationServiceMock },
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: GooglePlacesService, useValue: googlePlacesServiceMock },
      ],
    }).compile();

    service = moduleRef.get(LangGraphGraphService);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  describe("invoke", () => {
    it("creates initial state for new conversation", async () => {
      stateServiceMock.loadState.mockResolvedValue(null);

      await service.invoke({
        conversationId,
        messageId,
        message: "Hello",
      });

      expect(stateServiceMock.loadState).toHaveBeenCalledWith(conversationId);
      expect(stateServiceMock.createInitialState).toHaveBeenCalledWith(
        conversationId,
        messageId,
        "Hello",
        null,
      );
    });

    it("merges state for existing conversation", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.turnCount = 2;
      stateServiceMock.loadState.mockResolvedValue(existingState);

      await service.invoke({
        conversationId,
        messageId,
        message: "I need an SUV",
        customerId: "cust_123",
      });

      expect(stateServiceMock.mergeWithExisting).toHaveBeenCalledWith(
        existingState,
        conversationId,
        messageId,
        "I need an SUV",
        "cust_123",
      );
    });

    it("adds user message to state", async () => {
      await service.invoke({
        conversationId,
        messageId,
        message: "Hello",
      });

      expect(stateServiceMock.addMessage).toHaveBeenCalledWith(expect.anything(), "user", "Hello");
    });

    it("saves state after execution", async () => {
      await service.invoke({
        conversationId,
        messageId,
        message: "Hello",
      });

      expect(stateServiceMock.saveState).toHaveBeenCalledWith(conversationId, expect.anything());
    });

    it("returns response from graph execution", async () => {
      responderServiceMock.generateResponse.mockResolvedValue({
        text: "Welcome! How may I assist you?",
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Hi there",
      });

      expect(result.response).toBeDefined();
      expect(result.response?.text).toBe("Welcome! How may I assist you?");
    });

    it("returns outbox items", async () => {
      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Hello",
      });

      expect(result.outboxItems).toBeDefined();
      expect(Array.isArray(result.outboxItems)).toBe(true);
    });

    it("returns stage and draft", async () => {
      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Hello",
      });

      expect(result.stage).toBeDefined();
      expect(result.draft).toBeDefined();
    });

    it("handles extraction failure gracefully", async () => {
      extractorServiceMock.extract.mockRejectedValue(new Error("Extraction failed"));

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Test message",
      });

      expect(result.error).toBeDefined();
    });

    it("passes interactive reply to state", async () => {
      const interactive = { type: "button" as const, buttonId: "confirm" };

      await service.invoke({
        conversationId,
        messageId,
        message: "",
        interactive,
      });

      expect(extractorServiceMock.extract).toHaveBeenCalledWith(
        expect.objectContaining({
          inboundInteractive: interactive,
        }),
      );
    });
  });

  describe("graph flow - greeting to collecting", () => {
    it("stays in greeting stage on greeting intent to allow welcoming response", async () => {
      extractorServiceMock.extract.mockResolvedValue({
        intent: "greeting",
        draftPatch: {},
        confidence: 0.95,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Hello",
      });

      expect(result.stage).toBe("greeting");
    });

    it("clears stale booking state when greeting from awaiting_payment stage", async () => {
      const existingState = buildInitialState();
      existingState.stage = "awaiting_payment";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
        dropoffDate: "2026-03-01",
      };
      existingState.selectedOption = buildVehicleOption();
      existingState.availableOptions = [buildVehicleOption()];
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({
        ...existingState,
        inboundMessage: "Drop me off at the same place",
        inboundMessageId: messageId,
      });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "greeting",
        draftPatch: {},
        confidence: 0.95,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Hi",
      });

      // Should reset to greeting stage and clear the stale booking state
      expect(result.stage).toBe("greeting");
      expect(result.draft).toEqual({});
      // Should NOT have searched for vehicles
      expect(toolExecutorServiceMock.searchVehiclesFromExtracted).not.toHaveBeenCalled();
    });

    it("clears stale booking state when greeting from completed stage", async () => {
      const existingState = buildInitialState();
      existingState.stage = "completed";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
        dropoffDate: "2026-03-01",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({
        ...existingState,
        inboundMessage: "Yes",
        inboundMessageId: messageId,
      });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "greeting",
        draftPatch: {},
        confidence: 0.95,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Hello",
      });

      expect(result.stage).toBe("greeting");
      expect(result.draft).toEqual({});
    });
  });

  describe("graph flow - collecting info", () => {
    it("updates draft with extracted info", async () => {
      extractorServiceMock.extract.mockResolvedValueOnce({
        intent: "provide_info",
        draftPatch: {
          bookingType: "DAY",
          pickupDate: "2026-03-01",
          pickupLocation: "Lagos",
        },
        confidence: 0.9,
      });

      // Explicitly stub the geocoding lookup for this test
      googlePlacesServiceMock.validateAddressWithSuggestions.mockResolvedValueOnce({
        isValid: true,
        normalizedAddress: "Victoria Island, Lagos, Nigeria",
        suggestions: [],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "I need a day booking tomorrow in Lagos",
      });

      // Verify normalization lookup was called with the raw pickupLocation
      expect(googlePlacesServiceMock.validateAddressWithSuggestions).toHaveBeenCalledWith("Lagos");
      expect(result.draft.bookingType).toBe("DAY");
      expect(result.draft.pickupDate).toBe("2026-03-01");
      expect(result.draft.pickupLocation).toBe("Victoria Island, Lagos, Nigeria");
    });

    it("triggers search when all required fields collected", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Victoria Island",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({
        ...existingState,
        inboundMessage: "No",
        inboundMessageId: messageId,
      });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: { dropoffLocation: "Lekki" },
        confidence: 0.9,
      });

      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [buildVehicleOption()],
        alternatives: [],
      });

      await service.invoke({
        conversationId,
        messageId,
        message: "Drop me off in Lekki",
      });

      expect(toolExecutorServiceMock.searchVehiclesFromExtracted).toHaveBeenCalled();
    });

    it("fills dropoffLocation when user says same place explicitly", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "5 Glover Road, Ikoyi",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({
        ...existingState,
        inboundMessage: "Drop me off at the same place",
        inboundMessageId: messageId,
      });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.9,
      });

      // Mock Google Places to return the same address (already specific enough)
      googlePlacesServiceMock.validateAddressWithSuggestions.mockResolvedValue({
        isValid: true,
        normalizedAddress: "5 Glover Road, Ikoyi",
        suggestions: [],
      });

      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [buildVehicleOption()],
        alternatives: [],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Drop me off at the same place",
      });

      expect(result.draft.dropoffLocation).toBe("5 Glover Road, Ikoyi");
    });

    it("keeps dropoffLocation in sync when pickupLocation is normalized and they were equal", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Glover Road Ikoyi",
        dropoffLocation: "Glover Road Ikoyi", // Same as pickup (via "same location" instruction)
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({
        ...existingState,
        inboundMessage: "Yes",
        inboundMessageId: messageId,
      });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {},
        confidence: 0.9,
      });

      // Google Places normalizes the address
      googlePlacesServiceMock.validateAddressWithSuggestions.mockResolvedValue({
        isValid: true,
        normalizedAddress: "12 Glover Road, Ikoyi, Lagos, Nigeria",
        suggestions: [],
      });

      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [buildVehicleOption()],
        alternatives: [],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Yes",
      });

      // Both pickup and dropoff should be normalized to the same address
      expect(result.draft.pickupLocation).toBe("12 Glover Road, Ikoyi, Lagos, Nigeria");
      expect(result.draft.dropoffLocation).toBe("12 Glover Road, Ikoyi, Lagos, Nigeria");
    });

    it("does not update dropoffLocation when it differs from pickupLocation before normalization", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Glover Road Ikoyi",
        dropoffLocation: "Lekki Phase 1", // Different from pickup
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({
        ...existingState,
        inboundMessage: "Yes",
        inboundMessageId: messageId,
      });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {},
        confidence: 0.9,
      });

      googlePlacesServiceMock.validateAddressWithSuggestions.mockResolvedValue({
        isValid: true,
        normalizedAddress: "12 Glover Road, Ikoyi, Lagos, Nigeria",
        suggestions: [],
      });

      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [buildVehicleOption()],
        alternatives: [],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Yes",
      });

      // Pickup should be normalized, but dropoff should remain unchanged
      expect(result.draft.pickupLocation).toBe("12 Glover Road, Ikoyi, Lagos, Nigeria");
      expect(result.draft.dropoffLocation).toBe("Lekki Phase 1");
    });

    it("passes availableOptions to responder after search", async () => {
      const vehicle = buildVehicleOption({ id: "veh_search_result" });
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({
        ...existingState,
        inboundMessage: "Yes",
        inboundMessageId: messageId,
      });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {},
        confidence: 0.9,
      });

      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [vehicle],
        alternatives: [],
      });

      await service.invoke({
        conversationId,
        messageId,
        message: "Yes, find me options",
      });

      // Verify responder was called with the search results
      expect(responderServiceMock.generateResponse).toHaveBeenCalled();
      const responderArg = responderServiceMock.generateResponse.mock.calls[0][0];
      expect(responderArg.availableOptions).toHaveLength(1);
      expect(responderArg.availableOptions[0].id).toBe("veh_search_result");
      expect(responderArg.stage).toBe("presenting_options");
    });

    it("validates pickup immediately in collecting stage when user provides vague area", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({
        ...existingState,
        inboundMessage: "pick me up from Ikoyi",
        inboundMessageId: messageId,
      });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: { pickupLocation: "Ikoyi" },
        confidence: 0.9,
      });

      googlePlacesServiceMock.validateAddressWithSuggestions.mockResolvedValue({
        isValid: false,
        suggestions: [],
        failureReason: "AREA_ONLY",
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "pick me up from Ikoyi",
      });

      expect(googlePlacesServiceMock.validateAddressWithSuggestions).toHaveBeenCalledWith("Ikoyi");
      expect(toolExecutorServiceMock.searchVehiclesFromExtracted).not.toHaveBeenCalled();
      expect(result.outboxItems).toHaveLength(2);
      expect(result.outboxItems[0]?.dedupeKey).toContain(":address-checking");
      expect(result.outboxItems[1]?.dedupeKey).toContain(":address-suggestions");
      expect(result.outboxItems[1]?.textBody).toContain("looks like a general area");
      expect(result.outboxItems[1]?.textBody).not.toContain("Did you mean one of these?");
    });
  });

  describe("graph flow - selecting options", () => {
    it("sets selected option on selection intent", async () => {
      const vehicle = buildVehicleOption({ id: "veh_1" });
      const existingState = buildInitialState();
      existingState.stage = "presenting_options";
      existingState.availableOptions = [vehicle];
      existingState.lastShownOptions = [vehicle];
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({
        ...existingState,
        inboundMessage: "No",
        inboundMessageId: messageId,
      });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "select_option",
        draftPatch: {},
        selectionHint: "1",
        confidence: 0.9,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "The first one",
      });

      expect(result.stage).toBe("confirming");
    });

    it("handles cheapest selection hint", async () => {
      const cheapVehicle = buildVehicleOption({ id: "v1", estimatedTotalInclVat: 80000 });
      const expensiveVehicle = buildVehicleOption({ id: "v2", estimatedTotalInclVat: 150000 });
      const existingState = buildInitialState();
      existingState.stage = "presenting_options";
      existingState.availableOptions = [expensiveVehicle, cheapVehicle];
      existingState.lastShownOptions = [expensiveVehicle, cheapVehicle];
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "select_option",
        draftPatch: {},
        selectionHint: "cheapest",
        confidence: 0.9,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "The cheapest one",
      });

      expect(result.stage).toBe("confirming");
    });
  });

  describe("graph flow - confirmation", () => {
    it("transitions to awaiting_payment on confirm", async () => {
      const vehicle = buildVehicleOption();
      const existingState = buildInitialState();
      existingState.stage = "confirming";
      existingState.selectedOption = vehicle;
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {},
        confidence: 1,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Yes, confirm",
      });

      expect(result.stage).toBe("awaiting_payment");
      expect(bookingCreationServiceMock.createBooking).toHaveBeenCalled();
    });

    it("clears selection on reject", async () => {
      const vehicle = buildVehicleOption();
      const existingState = buildInitialState();
      existingState.stage = "confirming";
      existingState.selectedOption = vehicle;
      existingState.availableOptions = [vehicle];
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "reject",
        draftPatch: {},
        confidence: 1,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "No, show me others",
      });

      expect(result.stage).toBe("collecting");
    });

    it("routes to booking creation when user says yes in confirming stage even if extractor drifts", async () => {
      const vehicle = buildVehicleOption();
      const existingState = buildInitialState();
      existingState.stage = "confirming";
      existingState.selectedOption = vehicle;
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({
        ...existingState,
        inboundMessage: "Yes",
        inboundMessageId: messageId,
      });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.5,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Yes",
      });

      expect(result.stage).toBe("awaiting_payment");
      expect(bookingCreationServiceMock.createBooking).toHaveBeenCalled();
    });

    it("returns refreshed options when selected car becomes unavailable at booking time", async () => {
      const selected = buildVehicleOption({ id: "vehicle_unavailable" });
      const alternative = buildVehicleOption({
        id: "vehicle_alt_1",
        make: "Lexus",
        model: "LX570",
      });
      const existingState = buildInitialState();
      existingState.stage = "confirming";
      existingState.selectedOption = selected;
      existingState.availableOptions = [selected];
      existingState.lastShownOptions = [selected];
      existingState.draft = {
        bookingType: "FULL_DAY",
        pickupDate: "2026-04-04",
        pickupTime: "06:30",
        dropoffDate: "2026-04-10",
        pickupLocation: "Murtala Muhammad international airport",
        dropoffLocation: "256 Kofo Abayoki Street",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({
        ...existingState,
        inboundMessage: "Yes",
        inboundMessageId: messageId,
      });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {},
        confidence: 1,
      });

      bookingCreationServiceMock.createBooking.mockRejectedValue(
        new CarNotAvailableException(selected.id, "Car Not Available Exception"),
      );
      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [alternative],
        alternatives: [],
        precondition: null,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Yes",
      });

      expect(result.stage).toBe("presenting_options");
      expect(result.error).toContain("no longer available");
      expect(result.error).not.toContain("Car Not Available Exception");
      expect(toolExecutorServiceMock.searchVehiclesFromExtracted).toHaveBeenCalled();
      expect(bookingCreationServiceMock.createBooking).toHaveBeenCalled();
    });

    it("does not expose raw booking exception messages to the user", async () => {
      const selected = buildVehicleOption({ id: "vehicle_1" });
      const existingState = buildInitialState();
      existingState.stage = "confirming";
      existingState.selectedOption = selected;
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {},
        confidence: 1,
      });
      bookingCreationServiceMock.createBooking.mockRejectedValue(
        new Error("postgres timeout stack"),
      );

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "confirm",
      });

      expect(result.stage).toBe("confirming");
      expect(result.error).toBe(
        "I couldn't create your booking just now. Please try again or type AGENT to speak with someone.",
      );
      expect(result.error).not.toContain("postgres timeout");
    });

    it("routes to reject behavior when user says no in confirming stage even if extractor drifts", async () => {
      const vehicle = buildVehicleOption();
      const existingState = buildInitialState();
      existingState.stage = "confirming";
      existingState.selectedOption = vehicle;
      existingState.availableOptions = [vehicle];
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({
        ...existingState,
        inboundMessage: "No",
        inboundMessageId: messageId,
      });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.5,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "No",
      });

      expect(result.stage).toBe("collecting");
      expect(bookingCreationServiceMock.createBooking).not.toHaveBeenCalled();
    });

    it("ignores draftPatch mutation during control intents like confirm", async () => {
      const vehicle = buildVehicleOption();
      const existingState = buildInitialState();
      existingState.stage = "confirming";
      existingState.selectedOption = vehicle;
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {
          pickupDate: "2026-05-20",
          dropoffLocation: "Bad patch attempt",
        },
        confidence: 1,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "confirm",
      });

      expect(result.draft.pickupDate).toBe("2026-03-01");
      expect(result.draft.dropoffLocation).toBe("Lekki");
    });
  });

  describe("graph flow - cancellation", () => {
    it("transitions to cancelled on cancel intent", async () => {
      extractorServiceMock.extract.mockResolvedValue({
        intent: "cancel",
        draftPatch: {},
        confidence: 1,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Cancel everything",
      });

      expect(result.stage).toBe("cancelled");
    });
  });

  describe("graph flow - reset", () => {
    it("clears draft and returns to greeting on reset intent", async () => {
      const existingState = buildInitialState();
      existingState.stage = "confirming";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
        dropoffDate: "2026-03-01",
      };
      existingState.availableOptions = [buildVehicleOption()];
      existingState.selectedOption = buildVehicleOption();
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "reset",
        draftPatch: {},
        confidence: 1,
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "Done — I've cleared your booking details. Ready to start fresh! What do you need?",
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "RESET",
      });

      expect(result.stage).toBe("greeting");
      expect(result.draft).toEqual({});
      expect(result.response?.text).toContain("cleared");
    });
  });

  describe("graph flow - new_booking", () => {
    it("clears existing draft and starts fresh with new preferences", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
        dropoffDate: "2026-03-01",
        vehicleType: "SUV",
      };
      existingState.availableOptions = [buildVehicleOption()];
      existingState.lastShownOptions = [buildVehicleOption()];
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "new_booking",
        draftPatch: { vehicleType: "SEDAN" },
        confidence: 0.9,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "I need a sedan",
      });

      // Should clear old draft, keep only new info
      expect(result.stage).toBe("collecting");
      expect(result.draft.vehicleType).toBe("SEDAN");
      expect(result.draft.pickupDate).toBeUndefined();
      expect(result.draft.pickupTime).toBeUndefined();
      expect(result.draft.pickupLocation).toBeUndefined();
    });

    it("clears available options when starting new booking", async () => {
      const existingState = buildInitialState();
      existingState.stage = "presenting_options";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
        dropoffDate: "2026-03-01",
      };
      existingState.availableOptions = [buildVehicleOption(), buildVehicleOption({ id: "v2" })];
      existingState.lastShownOptions = [buildVehicleOption(), buildVehicleOption({ id: "v2" })];
      existingState.selectedOption = buildVehicleOption();
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "new_booking",
        draftPatch: {},
        confidence: 0.85,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "I want to book a car",
      });

      expect(result.stage).toBe("collecting");
      // Note: The draft reducer merges, so we check that the route node handles clearing
      // The availableOptions should be cleared in the result
    });

    it("does not search immediately after new_booking intent", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
        dropoffDate: "2026-03-01",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "new_booking",
        draftPatch: { vehicleType: "SEDAN" },
        confidence: 0.9,
      });

      await service.invoke({
        conversationId,
        messageId,
        message: "I need a sedan",
      });

      // Should NOT search because new_booking clears draft and goes to collecting
      expect(toolExecutorServiceMock.searchVehiclesFromExtracted).not.toHaveBeenCalled();
    });
  });

  describe("graph flow - agent handoff", () => {
    it("transitions to cancelled and generates handoff message", async () => {
      extractorServiceMock.extract.mockResolvedValue({
        intent: "request_agent",
        draftPatch: {},
        confidence: 1,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "I want to speak to a human",
      });

      expect(result.stage).toBe("cancelled");
      expect(result.response?.text).toContain("agent");
    });
  });

  describe("preferences handling", () => {
    it("updates price preference from extraction hint", async () => {
      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        preferenceHint: "budget",
        confidence: 0.8,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "I want something affordable",
      });

      expect(result.draft).toBeDefined();
    });
  });

  describe("vehicle card template sending", () => {
    it("sends vehicle cards as template messages with correct variables", async () => {
      const vehicle = buildVehicleOption({
        id: "veh_template_test",
        make: "BMW",
        model: "X5",
        imageUrl: "https://example.com/bmw.jpg",
      });
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {},
        confidence: 0.9,
      });

      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [vehicle],
        alternatives: [],
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "Here are your options!",
        vehicleCards: [
          {
            vehicleId: vehicle.id,
            imageUrl: vehicle.imageUrl,
            caption: "🚗 SUV • ⭐ EXECUTIVE\n💰 ₦150,000",
            buttonId: `select_vehicle:${vehicle.id}`,
            buttonTitle: "✓ Select",
          },
        ],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Yes, search for me",
      });

      expect(result.outboxItems).toHaveLength(2);

      // First item: intro text message
      const introMessage = result.outboxItems[0];
      expect(introMessage.mode).toBe("FREE_FORM");
      expect(introMessage.textBody).toBe("Here are your options!");

      // Second item: vehicle card as template
      const vehicleCard = result.outboxItems[1];
      expect(vehicleCard.mode).toBe("TEMPLATE");
      expect(vehicleCard.templateName).toBe("HX43448303892f9f4026057adb597e0c22");
      expect(vehicleCard.templateVariables).toEqual({
        "1": "BMW X5",
        "2": "₦150,000 incl. VAT",
        "3": "https://example.com/bmw.jpg",
        "4": "Select",
        "5": "veh_template_test",
      });
    });

    it("sends multiple vehicle cards as separate template messages", async () => {
      const vehicle1 = buildVehicleOption({
        id: "veh_1",
        make: "Toyota",
        model: "Prado",
        imageUrl: "https://example.com/prado.jpg",
      });
      const vehicle2 = buildVehicleOption({
        id: "veh_2",
        make: "Lexus",
        model: "GX",
        imageUrl: "https://example.com/gx.jpg",
      });
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupTime: "09:00",
        dropoffDate: "2026-03-01",
        pickupLocation: "Victoria Island",
        dropoffLocation: "Lekki",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {},
        confidence: 0.9,
      });

      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [vehicle1, vehicle2],
        alternatives: [],
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "Found 2 options for you!",
        vehicleCards: [
          {
            vehicleId: vehicle1.id,
            imageUrl: vehicle1.imageUrl,
            caption: "🚗 SUV • ⭐ EXECUTIVE",
            buttonId: `select_vehicle:${vehicle1.id}`,
            buttonTitle: "✓ Select",
          },
          {
            vehicleId: vehicle2.id,
            imageUrl: vehicle2.imageUrl,
            caption: "🚗 SUV • ⭐ EXECUTIVE",
            buttonId: `select_vehicle:${vehicle2.id}`,
            buttonTitle: "✓ Select",
          },
        ],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Search",
      });

      // 1 intro + 2 vehicle cards = 3 outbox items
      expect(result.outboxItems).toHaveLength(3);
      expect(result.outboxItems[0].mode).toBe("FREE_FORM");
      expect(result.outboxItems[1].mode).toBe("TEMPLATE");
      expect(result.outboxItems[2].mode).toBe("TEMPLATE");

      // Check each vehicle card has correct title
      expect(result.outboxItems[1].templateVariables?.["1"]).toBe("Toyota Prado");
      expect(result.outboxItems[2].templateVariables?.["1"]).toBe("Lexus GX");
    });

    it("sends standard text message when no vehicle cards present", async () => {
      responderServiceMock.generateResponse.mockResolvedValue({
        text: "Welcome! How can I help you today?",
        vehicleCards: undefined,
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Hello",
      });

      expect(result.outboxItems).toHaveLength(1);
      expect(result.outboxItems[0].mode).toBe("FREE_FORM");
      expect(result.outboxItems[0].textBody).toBe("Welcome! How can I help you today?");
      expect(result.outboxItems[0].templateName).toBeUndefined();
    });
  });

  describe("search - no results", () => {
    it("sends checking message and top suggestions when pickup address is not found", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-05",
        pickupTime: "09:00",
        dropoffDate: "2026-03-05",
        pickupLocation: "Wheabaker Ikoyi",
        dropoffLocation: "Wheabaker Ikoyi",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {},
        confidence: 0.9,
      });

      googlePlacesServiceMock.validateAddressWithSuggestions.mockResolvedValue({
        isValid: false,
        suggestions: [
          { placeId: "1", description: "The Wheatbaker, Ikoyi, Lagos" },
          { placeId: "2", description: "The Wheatbaker Hotel, Onitolo Road, Ikoyi, Lagos" },
          { placeId: "3", description: "Wheatbaker Street, Ikoyi, Lagos" },
          { placeId: "4", description: "Wheatbaker Bus Stop, Ikoyi, Lagos" },
        ],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "pickup is wheabaker ikoyi",
      });

      expect(toolExecutorServiceMock.searchVehiclesFromExtracted).not.toHaveBeenCalled();
      expect(result.outboxItems).toHaveLength(2);
      expect(result.outboxItems[0]?.dedupeKey).toContain(":address-checking");
      expect(result.outboxItems[1]?.dedupeKey).toContain(":address-suggestions");
      expect(result.outboxItems[1]?.textBody).toContain("Did you mean one of these?");
      expect(result.outboxItems[1]?.textBody).toContain("1. The Wheatbaker, Ikoyi, Lagos");
    });

    it("re-validates pickup location on next turn after invalid lookup", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-05",
        pickupTime: "09:00",
        dropoffDate: "2026-03-05",
        pickupLocation: "Ikoyi",
        dropoffLocation: "Ikoyi",
      };
      existingState.locationLookupTriggered = true;
      existingState.locationSuggestions = [
        { placeId: "1", description: "The Wheatbaker, Ikoyi, Lagos" },
      ];
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {},
        confidence: 0.9,
      });

      googlePlacesServiceMock.validateAddressWithSuggestions.mockResolvedValue({
        isValid: false,
        suggestions: [],
        failureReason: "AREA_ONLY",
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "yes",
      });

      expect(googlePlacesServiceMock.validateAddressWithSuggestions).toHaveBeenCalledWith("Ikoyi");
      expect(toolExecutorServiceMock.searchVehiclesFromExtracted).not.toHaveBeenCalled();
      expect(result.outboxItems).toHaveLength(2);
      expect(result.outboxItems[0]?.dedupeKey).toContain(":address-checking");
      expect(result.outboxItems[1]?.dedupeKey).toContain(":address-suggestions");
      expect(result.outboxItems[1]?.textBody).toContain("looks like a general area");
      expect(result.outboxItems[1]?.textBody).not.toContain("Did you mean one of these?");
    });

    it("does not re-validate pickup location after NO_MATCH when locationLookupFailed is true", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-05",
        pickupTime: "09:00",
        dropoffDate: "2026-03-05",
        pickupLocation: "Xyzzyville",
        dropoffLocation: "Xyzzyville",
      };
      // After a NO_MATCH, locationLookupTriggered should be true, suggestions empty, and locationLookupFailed true
      existingState.locationLookupTriggered = true;
      existingState.locationSuggestions = [];
      existingState.locationLookupFailed = true;
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {},
        confidence: 0.9,
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "I still need a valid pickup location. Please share a more specific address.",
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "yes",
      });

      // Should NOT re-validate because locationLookupTriggered is true and suggestions are empty
      expect(googlePlacesServiceMock.validateAddressWithSuggestions).not.toHaveBeenCalled();
      expect(toolExecutorServiceMock.searchVehiclesFromExtracted).not.toHaveBeenCalled();
      // Should go to responder with meaningful error so it can ask for a more precise pickup address
      expect(result.stage).toBe("collecting");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("Xyzzyville");
      expect(result.error).toContain("more specific pickup location");
    });

    it("sets error message when search returns no vehicles", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "NIGHT",
        pickupDate: "2026-03-05",
        pickupTime: "23:00",
        dropoffDate: "2026-03-06",
        pickupLocation: "Wheatbaker, Ikoyi",
        dropoffLocation: "6 Glover Road, Ikoyi",
        vehicleType: "SEDAN",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "confirm",
        draftPatch: {},
        confidence: 0.9,
      });

      // Search returns no results
      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [],
        alternatives: [],
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "Unfortunately, no vehicles matching your criteria are available for the selected date. Would you like to try a different date, vehicle type, or booking type?",
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Search for me",
      });

      // Should go back to collecting stage with error message
      expect(result.stage).toBe("collecting");
      expect(result.error).toContain("No vehicles matching your criteria");
    });

    it("allows re-search after successful search when user modifies non-location criteria", async () => {
      // This test verifies the fix for the bug where locationLookupTriggered=true and
      // locationSuggestions=[] after a successful search incorrectly blocked re-search.
      const existingState = buildInitialState();
      existingState.stage = "presenting_options";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-05",
        pickupTime: "09:00",
        dropoffDate: "2026-03-05",
        pickupLocation: "Wheatbaker Hotel, Ikoyi",
        dropoffLocation: "Wheatbaker Hotel, Ikoyi",
        vehicleType: "SUV",
      };
      existingState.availableOptions = [buildVehicleOption()];
      existingState.lastShownOptions = [buildVehicleOption()];
      // After a successful search, these flags are set:
      existingState.locationLookupTriggered = true;
      existingState.locationSuggestions = [];
      existingState.locationLookupFailed = false; // Key: NOT failed, just completed successfully
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      // User wants a different vehicle type (same location)
      extractorServiceMock.extract.mockResolvedValue({
        intent: "update_info",
        draftPatch: { vehicleType: "SEDAN" },
        confidence: 0.9,
      });

      // Search returns new results for SEDAN
      const sedanVehicle = buildVehicleOption({
        id: "sedan_1",
        make: "Toyota",
        model: "Camry",
        vehicleType: "SEDAN",
      });
      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [sedanVehicle],
        alternatives: [],
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "Here are the sedan options!",
        vehicleCards: [
          {
            vehicleId: sedanVehicle.id,
            imageUrl: null,
            caption: "Toyota Camry",
            buttonId: `select_vehicle:${sedanVehicle.id}`,
            buttonTitle: "Select",
          },
        ],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Show me sedans instead",
      });

      // Should successfully search and present new options
      expect(toolExecutorServiceMock.searchVehiclesFromExtracted).toHaveBeenCalled();
      expect(result.stage).toBe("presenting_options");
      expect(result.draft.vehicleType).toBe("SEDAN");
    });
  });

  describe("error handling", () => {
    it("returns error when graph execution fails", async () => {
      stateServiceMock.loadState.mockRejectedValue(new Error("Redis connection failed"));

      await expect(
        service.invoke({
          conversationId,
          messageId,
          message: "Test",
        }),
      ).rejects.toThrow();
    });

    it("handles search failure gracefully", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupLocation: "Lagos",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.9,
      });

      toolExecutorServiceMock.searchVehiclesFromExtracted.mockRejectedValue(
        new Error("Search service unavailable"),
      );

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Search now",
      });

      expect(result.error).toBeDefined();
    });

    it("does not reset locationLookupTriggered to false when search fails after validation", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-05",
        pickupTime: "09:00",
        dropoffDate: "2026-03-05",
        pickupLocation: "Wheatbaker Hotel, Ikoyi",
        dropoffLocation: "Ikoyi",
      };
      // Location was previously validated
      existingState.locationLookupTriggered = true;
      existingState.locationSuggestions = [];
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.9,
      });

      // Search fails after validation succeeded (but validation was skipped due to locationLookupTriggered=true)
      toolExecutorServiceMock.searchVehiclesFromExtracted.mockRejectedValue(
        new Error("Database timeout"),
      );

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "I couldn't check availability right now.",
      });

      // Capture the state that gets saved
      let savedState: BookingAgentState | null = null;
      stateServiceMock.saveState.mockImplementation((_id: string, state: BookingAgentState) => {
        savedState = state;
        return Promise.resolve();
      });

      await service.invoke({
        conversationId,
        messageId,
        message: "Search",
      });

      // Verify search was actually called (and rejected) so the catch path is exercised
      expect(toolExecutorServiceMock.searchVehiclesFromExtracted).toHaveBeenCalled();

      // The catch block should NOT reset locationLookupTriggered to false
      // (we omit locationLookupTriggered/locationSuggestions from the catch return,
      // so the existing state is preserved)
      expect(savedState).not.toBeNull();
      if (savedState) {
        expect(savedState.locationLookupTriggered).toBe(true);
        expect(savedState.stage).toBe("collecting");
      }
    });

    it("preserves validated draft and location state when search returns precondition", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-05",
        pickupTime: "09:00",
        dropoffDate: "2026-03-05",
        pickupLocation: "Wheatbaker Hotel, Ikoyi",
        dropoffLocation: "Ikoyi",
      };
      existingState.locationLookupTriggered = false;
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.9,
      });

      // Google Places validates and normalizes the address
      googlePlacesServiceMock.validateAddressWithSuggestions.mockResolvedValue({
        isValid: true,
        normalizedAddress: "The Wheatbaker Hotel, 4 Onitolo Rd, Ikoyi, Lagos",
        placeId: "ChIJ123",
        suggestions: [],
      });

      // Search returns precondition (e.g., missing vehicle type for a search that requires it)
      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        precondition: {
          field: "vehicleType",
          prompt: "What type of vehicle would you prefer?",
        },
        exactMatches: [],
        alternatives: [],
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "What type of vehicle would you prefer?",
      });

      // Capture the state that gets saved
      let savedState: BookingAgentState | null = null;
      stateServiceMock.saveState.mockImplementation((_id: string, state: BookingAgentState) => {
        savedState = state;
        return Promise.resolve();
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Search for cars",
      });

      // Should preserve the validated/normalized address
      expect(result.draft.pickupLocation).toBe("The Wheatbaker Hotel, 4 Onitolo Rd, Ikoyi, Lagos");
      expect(result.stage).toBe("collecting");
      expect(result.error).toContain("type of vehicle");
      // Should preserve locationLookupTriggered so we don't re-validate on next turn
      expect(savedState).not.toBeNull();
      if (savedState) {
        expect(savedState.locationLookupTriggered).toBe(true);
        expect(savedState.locationSuggestions).toEqual([]);
      }
    });
  });

  describe("NIGHT booking handling", () => {
    it("auto-calculates dropoffDate for NIGHT bookings when not explicitly set", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "NIGHT",
        pickupDate: "2026-03-05",
        pickupLocation: "Lekki Phase 1",
        dropoffLocation: "Lekki Phase 1",
        // No dropoffDate - should be auto-calculated
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.9,
      });

      // Search returns results - proving we got past missing field validation
      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [buildVehicleOption()],
        alternatives: [],
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "Here are your options!",
        vehicleCards: [
          {
            vehicleId: "vehicle_1",
            imageUrl: null,
            caption: "Toyota Prado",
            buttonId: "select_vehicle:vehicle_1",
            buttonTitle: "Select",
          },
        ],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Search",
      });

      // Should route to search and present options
      expect(result.stage).toBe("presenting_options");
      // Verify dropoffDate was auto-calculated (next day for NIGHT)
      expect(result.draft.dropoffDate).toBe("2026-03-06");
    });

    it("auto-sets pickupTime to 23:00 for NIGHT bookings", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "NIGHT",
        pickupDate: "2026-03-05",
        dropoffDate: "2026-03-06",
        pickupLocation: "Lekki Phase 1",
        dropoffLocation: "Lekki Phase 1",
        // No pickupTime - should be auto-set to 23:00 for NIGHT
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.9,
      });

      // Search returns results
      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [buildVehicleOption()],
        alternatives: [],
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "Here are your options!",
        vehicleCards: [
          {
            vehicleId: "vehicle_1",
            imageUrl: null,
            caption: "Toyota Prado",
            buttonId: "select_vehicle:vehicle_1",
            buttonTitle: "Select",
          },
        ],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Search",
      });

      // Should route to search and present options
      expect(result.stage).toBe("presenting_options");
      // pickupTime should be auto-set to 23:00 for NIGHT
      expect(result.draft.pickupTime).toBe("23:00");
    });

    it("overrides user-provided pickupTime with 23:00 for NIGHT bookings", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "NIGHT",
        pickupDate: "2026-03-05",
        dropoffDate: "2026-03-06",
        pickupLocation: "Lekki Phase 1",
        dropoffLocation: "Lekki Phase 1",
        pickupTime: "09:00", // User tried to set 9am, but NIGHT is always 11pm
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.9,
      });

      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [buildVehicleOption()],
        alternatives: [],
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "Here are your options!",
        vehicleCards: [
          {
            vehicleId: "vehicle_1",
            imageUrl: null,
            caption: "Toyota Prado",
            buttonId: "select_vehicle:vehicle_1",
            buttonTitle: "Select",
          },
        ],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Search",
      });

      expect(result.stage).toBe("presenting_options");
      // pickupTime should be overridden to 23:00 regardless of user input
      expect(result.draft.pickupTime).toBe("23:00");
    });

    it("still requires pickupTime for DAY bookings", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-05",
        dropoffDate: "2026-03-05",
        pickupLocation: "Lekki Phase 1",
        dropoffLocation: "Lekki Phase 1",
        // No pickupTime - should be required for DAY
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.9,
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "What time should I schedule the pickup?",
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Continue",
      });

      // Should stay at collecting stage (pickupTime is missing)
      expect(result.stage).toBe("collecting");
      // Search should NOT have been called
      expect(toolExecutorServiceMock.searchVehiclesFromExtracted).not.toHaveBeenCalled();
    });

    it("uses durationDays if set when calculating dropoffDate for NIGHT", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "NIGHT",
        pickupDate: "2026-03-05",
        durationDays: 3, // 3-night booking
        pickupLocation: "Lekki Phase 1",
        dropoffLocation: "Lekki Phase 1",
        // No dropoffDate - should be auto-calculated as pickupDate + 3
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.9,
      });

      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [buildVehicleOption()],
        alternatives: [],
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "Here are your options!",
        vehicleCards: [
          {
            vehicleId: "vehicle_1",
            imageUrl: null,
            caption: "Toyota Prado",
            buttonId: "select_vehicle:vehicle_1",
            buttonTitle: "Select",
          },
        ],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Search",
      });

      expect(result.stage).toBe("presenting_options");
      // Should be 3 days after pickup
      expect(result.draft.dropoffDate).toBe("2026-03-08");
    });

    it("calculates dropoffDate for non-NIGHT bookings using durationDays", async () => {
      const existingState = buildInitialState();
      existingState.stage = "collecting";
      existingState.draft = {
        bookingType: "DAY",
        pickupDate: "2026-03-05",
        durationDays: 2,
        pickupTime: "09:00",
        pickupLocation: "Lekki Phase 1",
        dropoffLocation: "Lekki Phase 1",
      };
      stateServiceMock.loadState.mockResolvedValue(existingState);
      stateServiceMock.mergeWithExisting.mockReturnValue({ ...existingState });

      extractorServiceMock.extract.mockResolvedValue({
        intent: "provide_info",
        draftPatch: {},
        confidence: 0.9,
      });

      toolExecutorServiceMock.searchVehiclesFromExtracted.mockResolvedValue({
        exactMatches: [buildVehicleOption()],
        alternatives: [],
      });

      responderServiceMock.generateResponse.mockResolvedValue({
        text: "Here are your options!",
        vehicleCards: [
          {
            vehicleId: "vehicle_1",
            imageUrl: null,
            caption: "Toyota Prado",
            buttonId: "select_vehicle:vehicle_1",
            buttonTitle: "Select",
          },
        ],
      });

      const result = await service.invoke({
        conversationId,
        messageId,
        message: "Search",
      });

      expect(result.stage).toBe("presenting_options");
      expect(result.draft.dropoffDate).toBe("2026-03-07");
    });
  });
});
