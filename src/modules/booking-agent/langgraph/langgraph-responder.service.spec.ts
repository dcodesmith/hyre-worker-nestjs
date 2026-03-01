import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingAgentState, VehicleSearchOption } from "./langgraph.interface";
import { LANGGRAPH_ANTHROPIC_CLIENT } from "./langgraph.tokens";
import { LangGraphResponderService } from "./langgraph-responder.service";

describe("LangGraphResponderService", () => {
  let moduleRef: TestingModule;
  let service: LangGraphResponderService;
  let claudeMock: {
    invoke: ReturnType<typeof vi.fn>;
  };

  const buildState = (overrides?: Partial<BookingAgentState>): BookingAgentState => ({
    conversationId: "conv_test",
    inboundMessage: "I need a car tomorrow",
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
    preferences: {},
    response: null,
    outboxItems: [],
    extraction: null,
    nextNode: null,
    error: null,
    ...overrides,
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
    claudeMock = {
      invoke: vi.fn(),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        LangGraphResponderService,
        {
          provide: LANGGRAPH_ANTHROPIC_CLIENT,
          useValue: claudeMock,
        },
      ],
    }).compile();

    service = moduleRef.get(LangGraphResponderService);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  describe("generateResponse", () => {
    it("generates response with string content", async () => {
      claudeMock.invoke.mockResolvedValue({
        content: "Hello! How can I help you with your booking today?",
      });

      const state = buildState({ stage: "greeting" });

      const response = await service.generateResponse(state);

      expect(response.text).toBe("Hello! How can I help you with your booking today?");
      expect(claudeMock.invoke).toHaveBeenCalled();
    });

    it("generates response with text block content", async () => {
      claudeMock.invoke.mockResolvedValue({
        content: [
          {
            type: "text",
            text: "Sure, I can help you find a vehicle!",
          },
        ],
      });

      const state = buildState();

      const response = await service.generateResponse(state);

      expect(response.text).toBe("Sure, I can help you find a vehicle!");
    });

    it("handles empty content array", async () => {
      claudeMock.invoke.mockResolvedValue({
        content: [],
      });

      const state = buildState();

      const response = await service.generateResponse(state);

      expect(response.text).toBe("");
    });

    it("throws on API error", async () => {
      claudeMock.invoke.mockRejectedValue(new Error("API timeout"));

      const state = buildState();

      await expect(service.generateResponse(state)).rejects.toThrow();
    });

    it("includes conversation history in context", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "Response" });

      const state = buildState({
        messages: [
          { role: "user", content: "Hi", timestamp: "2026-02-27T10:00:00Z" },
          { role: "assistant", content: "Hello!", timestamp: "2026-02-27T10:00:01Z" },
          { role: "user", content: "I need a car", timestamp: "2026-02-27T10:00:02Z" },
        ],
      });

      await service.generateResponse(state);

      expect(claudeMock.invoke).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Hi" }),
          expect.objectContaining({ role: "assistant", content: "Hello!" }),
          expect.objectContaining({ role: "user", content: "I need a car" }),
        ]),
      );
    });

    it("limits conversation history to last 6 messages", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "Response" });

      const messages = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `Message ${i}`,
        timestamp: new Date().toISOString(),
      }));

      const state = buildState({ messages });

      await service.generateResponse(state);

      const callArgs = claudeMock.invoke.mock.calls[0][0];
      const messageRoles = callArgs.filter(
        (m: { role: string }) => m.role === "user" || m.role === "assistant",
      );
      expect(messageRoles.length).toBeLessThanOrEqual(8);
    });
  });

  describe("interactive payloads", () => {
    it("returns vehicle cards when presenting options", async () => {
      const options = [
        buildVehicleOption({
          id: "1",
          make: "Toyota",
          model: "Prado",
          estimatedTotalInclVat: 100000,
        }),
        buildVehicleOption({
          id: "2",
          make: "Lexus",
          model: "GX460",
          estimatedTotalInclVat: 150000,
        }),
      ];

      const state = buildState({
        stage: "presenting_options",
        availableOptions: options,
      });

      const response = await service.generateResponse(state);

      // presenting_options now returns fixed intro and vehicle cards instead of interactive list
      expect(response.text).toBe(
        "Here are your options! Tap Select on the one you'd like to book.",
      );
      expect(response.vehicleCards).toBeDefined();
      expect(response.vehicleCards).toHaveLength(2);
      expect(response.vehicleCards?.[0].vehicleId).toBe("1");
      expect(response.vehicleCards?.[1].vehicleId).toBe("2");
    });

    it("builds vehicle card captions correctly", async () => {
      const options = [buildVehicleOption({ make: "Mercedes-Benz", model: "S-Class" })];

      const state = buildState({
        stage: "presenting_options",
        availableOptions: options,
        draft: { bookingType: "DAY" },
      });

      const response = await service.generateResponse(state);

      expect(response.vehicleCards).toHaveLength(1);
      expect(response.vehicleCards?.[0].caption).toContain("Mercedes-Benz S-Class");
      expect(response.vehicleCards?.[0].caption).toContain("₦150,000");
    });

    it("returns confirm/reject buttons when confirming selection", async () => {
      const state = buildState({
        stage: "confirming",
        selectedOption: buildVehicleOption(),
        draft: {
          bookingType: "DAY",
          pickupDate: "2026-03-01",
          durationDays: 2,
          pickupTime: "09:00",
          pickupLocation: "Victoria Island",
          dropoffLocation: "Lekki",
        },
      });

      const response = await service.generateResponse(state);

      // confirming stage now returns fixed booking summary with interactive buttons
      expect(response.text).toContain("Booking Summary");
      expect(response.text).toContain("Toyota Prado");
      expect(response.text).toContain("Duration:* 2 days");
      expect(response.interactive).toBeDefined();
      expect(response.interactive?.type).toBe("buttons");
      expect(response.interactive?.buttons).toHaveLength(3);
      expect(response.interactive?.buttons?.[0].id).toBe("confirm");
      expect(response.interactive?.buttons?.[1].id).toBe("no");
      expect(response.interactive?.buttons?.[2].id).toBe("show_others");
    });

    it("derives duration from dates when durationDays is not present", async () => {
      const state = buildState({
        stage: "confirming",
        selectedOption: buildVehicleOption(),
        draft: {
          bookingType: "FULL_DAY",
          pickupDate: "2026-04-04",
          dropoffDate: "2026-04-10",
          pickupTime: "06:30",
          pickupLocation: "Murtala Muhammad international airport",
          dropoffLocation: "256 Kofo Abayoki Street",
        },
      });

      const response = await service.generateResponse(state);

      expect(response.text).toContain("Duration:* 6 days");
    });

    it("returns retry and agent buttons when confirming has booking error", async () => {
      const state = buildState({
        stage: "confirming",
        error:
          "I couldn't create your booking just now. Please try again or type AGENT to speak with someone.",
        selectedOption: buildVehicleOption(),
        draft: {
          bookingType: "DAY",
          pickupDate: "2026-03-01",
          pickupTime: "09:00",
          pickupLocation: "Victoria Island",
          dropoffLocation: "Lekki",
        },
      });

      const response = await service.generateResponse(state);

      expect(response.text).toContain("I couldn't create your booking just now");
      expect(response.text).not.toContain("Reason:");
      expect(response.interactive?.type).toBe("buttons");
      expect(response.interactive?.buttons?.[0].id).toBe("retry_booking");
      expect(response.interactive?.buttons?.[1].id).toBe("show_others");
      expect(response.interactive?.buttons?.[2].id).toBe("agent");
    });

    it("prepends availability fallback message when presenting refreshed options", async () => {
      const options = [buildVehicleOption({ id: "2", make: "Lexus", model: "LX570" })];

      const state = buildState({
        stage: "presenting_options",
        error:
          "That vehicle is no longer available for your selected date and time. Here are updated available options.",
        availableOptions: options,
      });

      const response = await service.generateResponse(state);

      expect(response.text).toContain("no longer available");
      expect(response.text).toContain("Here are your options");
      expect(response.vehicleCards).toHaveLength(1);
    });

    it("returns payment stage buttons", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "Payment pending" });

      const state = buildState({
        stage: "awaiting_payment",
      });

      const response = await service.generateResponse(state);

      expect(response.interactive?.type).toBe("buttons");
      expect(response.interactive?.buttons).toHaveLength(2);
      expect(response.interactive?.buttons?.[0].id).toBe("cancel");
      expect(response.interactive?.buttons?.[1].id).toBe("agent");
    });

    it("returns booking type buttons when collecting without booking type", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "What type of booking?" });

      const state = buildState({
        stage: "collecting",
        draft: { pickupLocation: "Lagos" },
      });

      const response = await service.generateResponse(state);

      expect(response.interactive?.type).toBe("buttons");
      expect(response.interactive?.buttons).toHaveLength(3);
      expect(response.interactive?.buttons?.[0].id).toBe("day");
      expect(response.interactive?.buttons?.[1].id).toBe("night");
      expect(response.interactive?.buttons?.[2].id).toBe("fullday");
    });

    it("returns no interactive when booking type is set", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "When do you need pickup?" });

      const state = buildState({
        stage: "collecting",
        draft: { bookingType: "DAY" },
      });

      const response = await service.generateResponse(state);

      expect(response.interactive).toBeUndefined();
    });

    it("returns no interactive for greeting stage", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "Hello!" });

      const state = buildState({
        stage: "greeting",
      });

      const response = await service.generateResponse(state);

      expect(response.interactive).toBeUndefined();
    });

    it("returns no interactive for empty options in presenting_options", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "No vehicles found" });

      const state = buildState({
        stage: "presenting_options",
        availableOptions: [],
      });

      const response = await service.generateResponse(state);

      expect(response.interactive).toBeUndefined();
    });

    it("returns no interactive for confirming without selection", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "Please select an option first" });

      const state = buildState({
        stage: "confirming",
        selectedOption: null,
      });

      const response = await service.generateResponse(state);

      expect(response.interactive).toBeUndefined();
    });

    it("limits list options to 10 items", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "Many options:" });

      const options = Array.from({ length: 15 }, (_, i) =>
        buildVehicleOption({ id: `v${i}`, make: `Make${i}` }),
      );

      const state = buildState({
        stage: "presenting_options",
        availableOptions: options,
      });

      const response = await service.generateResponse(state);

      expect(response.interactive).toBeUndefined();
    });
  });

  describe("context building", () => {
    it("includes draft info in context", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "Got it" });

      const state = buildState({
        draft: {
          bookingType: "DAY",
          pickupDate: "2026-03-01",
          pickupLocation: "Victoria Island",
        },
      });

      await service.generateResponse(state);

      const callArgs = claudeMock.invoke.mock.calls[0][0];
      const userContext = callArgs.find((m: { role: string }) => m.role === "user");
      expect(userContext.content).toContain("DAY");
      expect(userContext.content).toContain("2026-03-01");
      expect(userContext.content).toContain("Victoria Island");
    });

    it("includes extraction intent in context", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "Let me help" });

      const state = buildState({
        extraction: {
          intent: "ask_question",
          draftPatch: {},
          question: "What is the price?",
          confidence: 0.9,
        },
      });

      await service.generateResponse(state);

      const callArgs = claudeMock.invoke.mock.calls[0][0];
      const userContext = callArgs.find((m: { role: string }) => m.role === "user");
      expect(userContext.content).toContain("ask_question");
      expect(userContext.content).toContain("What is the price?");
    });

    it("includes available options in context", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "Here are options" });

      const options = [
        buildVehicleOption({ make: "Toyota", model: "Prado", estimatedTotalInclVat: 100000 }),
      ];

      const state = buildState({
        availableOptions: options,
      });

      await service.generateResponse(state);

      const callArgs = claudeMock.invoke.mock.calls[0][0];
      const userContext = callArgs.find((m: { role: string }) => m.role === "user");
      expect(userContext.content).toContain("Toyota Prado");
      expect(userContext.content).toContain("100,000");
    });

    it("includes turn count in context", async () => {
      claudeMock.invoke.mockResolvedValue({ content: "Response" });

      const state = buildState({ turnCount: 5 });

      await service.generateResponse(state);

      const callArgs = claudeMock.invoke.mock.calls[0][0];
      const userContext = callArgs.find((m: { role: string }) => m.role === "user");
      expect(userContext.content).toContain("TURN: 5");
    });
  });
});
