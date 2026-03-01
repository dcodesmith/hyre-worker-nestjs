import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BookingAgentState,
  InteractiveReply,
  VehicleSearchOption,
} from "./langgraph.interface";
import { LANGGRAPH_OPENAI_CLIENT } from "./langgraph.tokens";
import { LangGraphExtractorService } from "./langgraph-extractor.service";

describe("LangGraphExtractorService", () => {
  let moduleRef: TestingModule;
  let service: LangGraphExtractorService;
  let openaiMock: {
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
    openaiMock = {
      invoke: vi.fn(),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        LangGraphExtractorService,
        {
          provide: LANGGRAPH_OPENAI_CLIENT,
          useValue: openaiMock,
        },
      ],
    }).compile();

    service = moduleRef.get(LangGraphExtractorService);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  describe("extract - interactive replies", () => {
    it("handles confirm button", async () => {
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "confirm",
        title: "✓ Confirm",
      };
      const state = buildState({ inboundInteractive: interactive });

      const result = await service.extract(state);

      expect(result.intent).toBe("confirm");
      expect(result.confidence).toBe(1);
      expect(result.draftPatch).toEqual({});
      expect(openaiMock.invoke).not.toHaveBeenCalled();
    });

    it("handles yes button", async () => {
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "yes",
        title: "Yes",
      };
      const state = buildState({ inboundInteractive: interactive });

      const result = await service.extract(state);

      expect(result.intent).toBe("confirm");
      expect(result.confidence).toBe(1);
    });

    it("handles no button as reject", async () => {
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "no",
        title: "✕ No",
      };
      const state = buildState({ inboundInteractive: interactive });

      const result = await service.extract(state);

      expect(result.intent).toBe("reject");
      expect(result.confidence).toBe(1);
    });

    it("handles reject button", async () => {
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "reject",
      };
      const state = buildState({ inboundInteractive: interactive });

      const result = await service.extract(state);

      expect(result.intent).toBe("reject");
    });

    it("handles show_others button", async () => {
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "show_others",
      };
      const state = buildState({ inboundInteractive: interactive });

      const result = await service.extract(state);

      expect(result.intent).toBe("reject");
      expect(result.preferenceHint).toBe("show_alternatives");
    });

    it("handles more_options button", async () => {
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "more_options",
      };
      const state = buildState({ inboundInteractive: interactive });

      const result = await service.extract(state);

      expect(result.intent).toBe("reject");
      expect(result.preferenceHint).toBe("show_alternatives");
    });

    it("handles day booking type button", async () => {
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "day",
      };
      const state = buildState({ inboundInteractive: interactive });

      const result = await service.extract(state);

      expect(result.intent).toBe("provide_info");
      expect(result.draftPatch.bookingType).toBe("DAY");
      expect(result.confidence).toBe(1);
    });

    it("handles night booking type button", async () => {
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "night",
      };
      const state = buildState({ inboundInteractive: interactive });

      const result = await service.extract(state);

      expect(result.intent).toBe("provide_info");
      expect(result.draftPatch.bookingType).toBe("NIGHT");
      expect(result.confidence).toBe(1);
    });

    it("handles full day booking type button", async () => {
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "fullday",
      };
      const state = buildState({ inboundInteractive: interactive });

      const result = await service.extract(state);

      expect(result.intent).toBe("provide_info");
      expect(result.draftPatch.bookingType).toBe("FULL_DAY");
      expect(result.confidence).toBe(1);
    });

    it("handles cancel button", async () => {
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "cancel",
      };
      const state = buildState({ inboundInteractive: interactive });

      const result = await service.extract(state);

      expect(result.intent).toBe("cancel");
      expect(result.confidence).toBe(1);
    });

    it("handles agent request button", async () => {
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "agent",
      };
      const state = buildState({ inboundInteractive: interactive });

      const result = await service.extract(state);

      expect(result.intent).toBe("request_agent");
      expect(result.confidence).toBe(1);
    });

    it("handles vehicle list selection", async () => {
      const vehicle = buildVehicleOption({
        id: "veh_abc",
        make: "Lexus",
        model: "GX460",
        color: "white",
      });
      const interactive: InteractiveReply = {
        type: "list_reply",
        listRowId: "vehicle:veh_abc",
        title: "Lexus GX460",
      };
      const state = buildState({
        inboundInteractive: interactive,
        lastShownOptions: [vehicle],
      });

      const result = await service.extract(state);

      expect(result.intent).toBe("select_option");
      expect(result.selectionHint).toBe("veh_abc");
      expect(result.draftPatch.make).toBe("Lexus");
      expect(result.draftPatch.model).toBe("GX460");
      expect(result.draftPatch.color).toBe("white");
      expect(result.confidence).toBe(1);
    });

    it("handles select_vehicle button", async () => {
      const vehicle = buildVehicleOption({
        id: "veh_xyz",
        make: "Audi",
        model: "Q7",
        color: "silver",
      });
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "select_vehicle:veh_xyz",
        title: "✓ Select Audi Q7",
      };
      const state = buildState({
        inboundInteractive: interactive,
        lastShownOptions: [vehicle],
      });

      const result = await service.extract(state);

      expect(result.intent).toBe("select_option");
      expect(result.selectionHint).toBe("veh_xyz");
      expect(result.draftPatch.make).toBe("Audi");
      expect(result.draftPatch.model).toBe("Q7");
      expect(result.draftPatch.color).toBe("silver");
      expect(result.confidence).toBe(1);
    });

    it("handles raw vehicle ID button from Content Template", async () => {
      const vehicle = buildVehicleOption({
        id: "cmawmf8wl000hk8l2uhtjb9rr",
        make: "Land Rover",
        model: "Range Rover",
        color: "white",
      });
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "cmawmf8wl000hk8l2uhtjb9rr",
        title: "Select",
      };
      const state = buildState({
        inboundInteractive: interactive,
        lastShownOptions: [vehicle],
      });

      const result = await service.extract(state);

      expect(result.intent).toBe("select_option");
      expect(result.selectionHint).toBe("cmawmf8wl000hk8l2uhtjb9rr");
      expect(result.draftPatch.make).toBe("Land Rover");
      expect(result.draftPatch.model).toBe("Range Rover");
      expect(result.draftPatch.color).toBe("white");
      expect(result.confidence).toBe(1);
    });

    it("returns unknown for select_vehicle button with nonexistent vehicle", async () => {
      const interactive: InteractiveReply = {
        type: "button",
        buttonId: "select_vehicle:nonexistent",
      };
      const state = buildState({
        inboundInteractive: interactive,
        lastShownOptions: [buildVehicleOption()],
      });

      const result = await service.extract(state);

      expect(result.intent).toBe("unknown");
    });

    it("returns unknown for unrecognized list selection", async () => {
      const interactive: InteractiveReply = {
        type: "list_reply",
        listRowId: "vehicle:nonexistent",
      };
      const state = buildState({
        inboundInteractive: interactive,
        lastShownOptions: [buildVehicleOption()],
      });

      const result = await service.extract(state);

      expect(result.intent).toBe("unknown");
      expect(result.confidence).toBe(0.5);
    });

    it("handles vehicle with undefined color", async () => {
      const vehicle = buildVehicleOption({ id: "veh_1", color: undefined });
      const interactive: InteractiveReply = {
        type: "list_reply",
        listRowId: "vehicle:veh_1",
      };
      const state = buildState({
        inboundInteractive: interactive,
        lastShownOptions: [vehicle],
      });

      const result = await service.extract(state);

      expect(result.intent).toBe("select_option");
      expect(result.draftPatch.color).toBeUndefined();
    });
  });

  describe("extract - text messages", () => {
    it("uses deterministic confirm intent in confirming stage without LLM call", async () => {
      const state = buildState({
        inboundMessage: "yes",
        stage: "confirming",
      });

      const result = await service.extract(state);

      expect(result.intent).toBe("confirm");
      expect(result.confidence).toBe(1);
      expect(openaiMock.invoke).not.toHaveBeenCalled();
    });

    it("uses deterministic reject intent in confirming stage without LLM call", async () => {
      const state = buildState({
        inboundMessage: "no",
        stage: "confirming",
      });

      const result = await service.extract(state);

      expect(result.intent).toBe("reject");
      expect(result.confidence).toBe(1);
      expect(openaiMock.invoke).not.toHaveBeenCalled();
    });

    it("uses deterministic confirm intent for conversational affirmative message", async () => {
      const state = buildState({
        inboundMessage: "yes please, go ahead",
        stage: "confirming",
      });

      const result = await service.extract(state);

      expect(result.intent).toBe("confirm");
      expect(result.confidence).toBe(1);
      expect(openaiMock.invoke).not.toHaveBeenCalled();
    });

    it("uses deterministic reject intent for conversational negative message", async () => {
      const state = buildState({
        inboundMessage: "no, show me another option",
        stage: "confirming",
      });

      const result = await service.extract(state);

      expect(result.intent).toBe("reject");
      expect(result.confidence).toBe(1);
      expect(openaiMock.invoke).not.toHaveBeenCalled();
    });

    it("extracts greeting intent", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: JSON.stringify({
          intent: "greeting",
          draftPatch: {},
          confidence: 0.95,
        }),
      });

      const state = buildState({ inboundMessage: "Hello" });

      const result = await service.extract(state);

      expect(result.intent).toBe("greeting");
      expect(result.confidence).toBe(0.95);
      expect(openaiMock.invoke).toHaveBeenCalled();
    });

    it("extracts booking info from message", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: JSON.stringify({
          intent: "provide_info",
          draftPatch: {
            bookingType: "DAY",
            pickupDate: "2026-03-01",
            pickupTime: "09:00",
            pickupLocation: "Victoria Island",
          },
          confidence: 0.9,
        }),
      });

      const state = buildState({
        inboundMessage: "I need a day booking for tomorrow at 9am from Victoria Island",
      });

      const result = await service.extract(state);

      expect(result.intent).toBe("provide_info");
      expect(result.draftPatch.bookingType).toBe("DAY");
      expect(result.draftPatch.pickupDate).toBe("2026-03-01");
      expect(result.draftPatch.pickupTime).toBe("09:00");
      expect(result.draftPatch.pickupLocation).toBe("Victoria Island");
    });

    it("extracts selection hint when selecting option", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: JSON.stringify({
          intent: "select_option",
          draftPatch: {},
          selectionHint: "cheapest",
          confidence: 0.85,
        }),
      });

      const state = buildState({ inboundMessage: "Give me the cheapest one" });

      const result = await service.extract(state);

      expect(result.intent).toBe("select_option");
      expect(result.selectionHint).toBe("cheapest");
    });

    it("extracts preference hint", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: JSON.stringify({
          intent: "provide_info",
          draftPatch: { color: "black" },
          preferenceHint: "black",
          confidence: 0.8,
        }),
      });

      const state = buildState({ inboundMessage: "I prefer black cars" });

      const result = await service.extract(state);

      expect(result.preferenceHint).toBe("black");
      expect(result.draftPatch.color).toBe("black");
    });

    it("extracts question from user", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: JSON.stringify({
          intent: "ask_question",
          draftPatch: {},
          question: "What are the prices?",
          confidence: 0.9,
        }),
      });

      const state = buildState({ inboundMessage: "What are the prices?" });

      const result = await service.extract(state);

      expect(result.intent).toBe("ask_question");
      expect(result.question).toBe("What are the prices?");
    });

    it("handles text response from LLM", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              intent: "provide_info",
              draftPatch: { vehicleType: "SUV" },
              confidence: 0.85,
            }),
          },
        ],
      });

      const state = buildState({ inboundMessage: "I want an SUV" });

      const result = await service.extract(state);

      expect(result.intent).toBe("provide_info");
      expect(result.draftPatch.vehicleType).toBe("SUV");
    });

    it("throws on extraction failure", async () => {
      openaiMock.invoke.mockRejectedValue(new Error("API error"));

      const state = buildState({ inboundMessage: "test" });

      await expect(service.extract(state)).rejects.toThrow();
    });

    it("throws on invalid JSON response", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: "not valid json",
      });

      const state = buildState({ inboundMessage: "test" });

      await expect(service.extract(state)).rejects.toThrow();
    });

    it("throws on schema validation failure", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: JSON.stringify({
          intent: "invalid_intent",
          draftPatch: {},
          confidence: 0.5,
        }),
      });

      const state = buildState({ inboundMessage: "test" });

      await expect(service.extract(state)).rejects.toThrow();
    });

    it("extracts reset intent", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: JSON.stringify({
          intent: "reset",
          draftPatch: {},
          confidence: 1,
        }),
      });

      const state = buildState({ inboundMessage: "RESET" });

      const result = await service.extract(state);

      expect(result.intent).toBe("reset");
      expect(result.draftPatch).toEqual({});
      expect(result.confidence).toBe(1);
    });

    it("extracts new_booking intent with vehicle preference", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: JSON.stringify({
          intent: "new_booking",
          draftPatch: { vehicleType: "SEDAN" },
          confidence: 0.9,
        }),
      });

      const state = buildState({ inboundMessage: "I need a sedan" });

      const result = await service.extract(state);

      expect(result.intent).toBe("new_booking");
      expect(result.draftPatch.vehicleType).toBe("SEDAN");
    });

    it("extracts new_booking intent for generic car request", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: JSON.stringify({
          intent: "new_booking",
          draftPatch: {},
          confidence: 0.85,
        }),
      });

      const state = buildState({ inboundMessage: "I want to book a car" });

      const result = await service.extract(state);

      expect(result.intent).toBe("new_booking");
    });
  });

  describe("extract - with existing options", () => {
    it("includes options in system prompt context", async () => {
      const options = [
        buildVehicleOption({ id: "1", make: "Toyota", model: "Prado" }),
        buildVehicleOption({ id: "2", make: "Lexus", model: "GX460" }),
      ];

      openaiMock.invoke.mockResolvedValue({
        content: JSON.stringify({
          intent: "select_option",
          draftPatch: {},
          selectionHint: "1",
          confidence: 0.9,
        }),
      });

      const state = buildState({
        inboundMessage: "The first one",
        lastShownOptions: options,
      });

      await service.extract(state);

      expect(openaiMock.invoke).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Toyota Prado"),
          }),
        ]),
      );
    });
  });

  describe("extract - with conversation history", () => {
    it("includes conversation history in system prompt for context", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: JSON.stringify({
          intent: "confirm",
          draftPatch: {},
          confidence: 0.95,
        }),
      });

      const state = buildState({
        inboundMessage: "Absolutely, that works",
        stage: "confirming",
        messages: [
          { role: "user", content: "I want a car tomorrow", timestamp: "2026-02-28T10:00:00Z" },
          {
            role: "assistant",
            content: "Ready to confirm this booking?",
            timestamp: "2026-02-28T10:01:00Z",
          },
        ],
      });

      await service.extract(state);

      expect(openaiMock.invoke).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("RECENT CONVERSATION HISTORY"),
          }),
        ]),
      );

      // Verify the conversation history is included
      const systemCall = openaiMock.invoke.mock.calls[0][0];
      const systemPrompt = systemCall.find((m: { role: string }) => m.role === "system")?.content;
      expect(systemPrompt).toContain("Ready to confirm this booking?");
    });

    it("extracts confirm intent when user says yes to confirmation question", async () => {
      openaiMock.invoke.mockResolvedValue({
        content: JSON.stringify({
          intent: "confirm",
          draftPatch: {},
          confidence: 0.95,
        }),
      });

      const state = buildState({
        inboundMessage:
          "Yes this works, and please keep everything exactly as shown in the summary",
        stage: "confirming",
        messages: [
          {
            role: "assistant",
            content: "Ready to confirm this booking? Toyota Prado for tomorrow at 9am",
            timestamp: "2026-02-28T10:01:00Z",
          },
        ],
      });

      const result = await service.extract(state);

      expect(result.intent).toBe("confirm");
      expect(result.confidence).toBe(0.95);
      expect(openaiMock.invoke).toHaveBeenCalled();
    });
  });
});
