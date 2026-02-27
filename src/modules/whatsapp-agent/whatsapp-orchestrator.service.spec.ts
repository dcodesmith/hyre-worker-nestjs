import { Test, TestingModule } from "@nestjs/testing";
import { WhatsAppDeliveryMode, WhatsAppMessageKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VehicleSearchToolResult } from "./whatsapp-agent.interface";
import { WhatsAppFollowupQuestionService } from "./whatsapp-followup-question.service";
import { WhatsAppOrchestratorService } from "./whatsapp-orchestrator.service";
import { WhatsAppSearchSlotMemoryService } from "./whatsapp-search-slot-memory.service";
import { WhatsAppToolExecutorService } from "./whatsapp-tool-executor.service";
import { WhatsAppWindowPolicyService } from "./whatsapp-window-policy.service";

describe("WhatsAppOrchestratorService", () => {
  let moduleRef: TestingModule;
  let service: WhatsAppOrchestratorService;
  let windowPolicyService: { resolveOutboundMode: ReturnType<typeof vi.fn> };
  let toolExecutorService: { searchVehiclesFromMessage: ReturnType<typeof vi.fn> };
  let followupQuestionService: { buildFriendlyQuestion: ReturnType<typeof vi.fn> };
  let searchSlotMemoryService: { clear: ReturnType<typeof vi.fn> };

  const buildContext = (
    overrides?: Partial<Parameters<WhatsAppOrchestratorService["decide"]>[0]>,
  ) => ({
    messageId: "msg_1",
    conversationId: "conv_1",
    body: "Need an SUV tomorrow",
    kind: WhatsAppMessageKind.TEXT,
    windowExpiresAt: new Date("2026-02-26T12:00:00Z"),
    ...overrides,
  });

  beforeEach(async () => {
    windowPolicyService = {
      resolveOutboundMode: vi.fn().mockReturnValue(WhatsAppDeliveryMode.FREE_FORM),
    };
    toolExecutorService = {
      searchVehiclesFromMessage: vi.fn(),
    };
    followupQuestionService = {
      buildFriendlyQuestion: vi
        .fn()
        .mockImplementation(
          async ({ fallbackQuestion }: { fallbackQuestion: string }) => fallbackQuestion,
        ),
    };
    searchSlotMemoryService = {
      clear: vi.fn().mockResolvedValue(undefined),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppOrchestratorService,
        {
          provide: WhatsAppWindowPolicyService,
          useValue: windowPolicyService,
        },
        {
          provide: WhatsAppToolExecutorService,
          useValue: toolExecutorService,
        },
        {
          provide: WhatsAppFollowupQuestionService,
          useValue: followupQuestionService,
        },
        {
          provide: WhatsAppSearchSlotMemoryService,
          useValue: searchSlotMemoryService,
        },
      ],
    }).compile();

    service = moduleRef.get(WhatsAppOrchestratorService);
  });

  it("routes explicit AGENT request to handoff", async () => {
    const result = await service.decide(buildContext({ body: "agent" }));

    expect(result.markAsHandoff).toEqual({ reason: "USER_REQUESTED_AGENT" });
    expect(result.enqueueOutbox).toHaveLength(1);
    expect(toolExecutorService.searchVehiclesFromMessage).not.toHaveBeenCalled();
  });

  it("returns media fallback for inbound audio/image/doc messages", async () => {
    const result = await service.decide(buildContext({ kind: WhatsAppMessageKind.AUDIO }));
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("media-fallback:msg_1");
    expect(toolExecutorService.searchVehiclesFromMessage).not.toHaveBeenCalled();
  });

  it("builds options list and image messages when tool search returns vehicles", async () => {
    const toolResult: VehicleSearchToolResult = {
      interpretation: "Looking for: white suv",
      extracted: { color: "white", vehicleType: "SUV" },
      exactMatches: [
        {
          id: "car_1",
          make: "Toyota",
          model: "Prado",
          name: "Toyota Prado",
          color: "White",
          vehicleType: "SUV",
          serviceTier: "STANDARD",
          imageUrl: "https://img.example.com/car_1.jpg",
          rates: { day: 65000, night: 70000, fullDay: 110000, airportPickup: 40000 },
        },
        {
          id: "car_2",
          make: "Lexus",
          model: "RX",
          name: "Lexus RX",
          color: "Black",
          vehicleType: "SUV",
          serviceTier: "STANDARD",
          imageUrl: null,
          rates: { day: 60000, night: 65000, fullDay: 100000, airportPickup: 38000 },
        },
      ],
      alternatives: [],
      precondition: null,
      shouldClarifyBookingType: false,
    };
    toolExecutorService.searchVehiclesFromMessage.mockResolvedValue({
      kind: "ok",
      result: toolResult,
    });

    const result = await service.decide(buildContext());

    expect(toolExecutorService.searchVehiclesFromMessage).toHaveBeenCalledWith(
      "Need an SUV tomorrow",
      "conv_1",
    );
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("options-list:msg_1");
    expect(result.enqueueOutbox.some((item) => item.dedupeKey === "option-image:msg_1:car_1")).toBe(
      true,
    );
  });

  it("asks a precondition question when required search fields are missing", async () => {
    toolExecutorService.searchVehiclesFromMessage.mockResolvedValue({
      kind: "ok",
      result: {
        interpretation: "Looking for: black toyota",
        extracted: { make: "Toyota", color: "Black" },
        exactMatches: [],
        alternatives: [],
        precondition: {
          missingField: "from",
          prompt: "What date should pickup start? Please share it as YYYY-MM-DD.",
        },
        shouldClarifyBookingType: false,
      } satisfies VehicleSearchToolResult,
    });

    const result = await service.decide(buildContext());
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("collect-precondition:msg_1:from");
    expect(result.enqueueOutbox[0]?.textBody).toContain("What date should pickup start?");
    expect(followupQuestionService.buildFriendlyQuestion).toHaveBeenCalled();
  });

  it("builds alternatives response and asks booking-type clarification when exact match is unavailable", async () => {
    toolExecutorService.searchVehiclesFromMessage.mockResolvedValue({
      kind: "ok",
      result: {
        interpretation: "Looking for: black toyota prado",
        extracted: { make: "Toyota", model: "Prado", color: "Black", from: "2026-03-01" },
        exactMatches: [],
        alternatives: [
          {
            id: "car_a",
            make: "Toyota",
            model: "Prado",
            name: "Toyota Prado",
            color: "White",
            vehicleType: "SUV",
            serviceTier: "STANDARD",
            imageUrl: null,
            reason: "SAME_MODEL_DIFFERENT_COLOR",
            score: 65,
            rates: { day: 65000, night: 70000, fullDay: 110000, airportPickup: 40000 },
          },
        ],
        precondition: null,
        shouldClarifyBookingType: true,
      } satisfies VehicleSearchToolResult,
    });

    const result = await service.decide(buildContext());
    const optionsMessage = result.enqueueOutbox[0]?.textBody ?? "";
    expect(optionsMessage).toContain("No exact");
    expect(optionsMessage).toContain("same model, different color");
    expect(optionsMessage).toContain("Reply with DAY, NIGHT, or FULL_DAY.");
    expect(optionsMessage).toContain("pickup and drop-off locations");
  });

  it("asks only for missing drop-off location when pickup location is already provided", async () => {
    toolExecutorService.searchVehiclesFromMessage.mockResolvedValue({
      kind: "ok",
      result: {
        interpretation: "Looking for: black toyota prado",
        extracted: {
          make: "Toyota",
          model: "Prado",
          color: "Black",
          from: "2026-03-01",
          pickupLocation: "The George Hotel, Ikoyi",
        },
        exactMatches: [],
        alternatives: [
          {
            id: "car_a",
            make: "Toyota",
            model: "Prado",
            name: "Toyota Prado",
            color: "White",
            vehicleType: "SUV",
            serviceTier: "STANDARD",
            imageUrl: null,
            reason: "SAME_MODEL_DIFFERENT_COLOR",
            score: 65,
            rates: { day: 65000, night: 70000, fullDay: 110000, airportPickup: 40000 },
          },
        ],
        precondition: null,
        shouldClarifyBookingType: true,
      } satisfies VehicleSearchToolResult,
    });

    const result = await service.decide(buildContext());
    const optionsMessage = result.enqueueOutbox[0]?.textBody ?? "";
    expect(optionsMessage).toContain("Reply with DAY, NIGHT, or FULL_DAY.");
    expect(optionsMessage).toContain("drop-off location");
    expect(optionsMessage).not.toContain("pickup and drop-off locations");
  });

  it("returns a fallback message when tool execution returns an error result", async () => {
    toolExecutorService.searchVehiclesFromMessage.mockResolvedValue({
      kind: "error",
      error: "boom",
    });

    const result = await service.decide(buildContext({ body: "Need an SUV" }));
    expect(result.enqueueOutbox).toHaveLength(1);
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("tool-failure:msg_1");
    expect(result.enqueueOutbox[0]?.textBody).toContain(
      "I hit a temporary issue while checking availability.",
    );
  });

  it("asks for details when model/tool extraction cannot determine search intent", async () => {
    toolExecutorService.searchVehiclesFromMessage.mockResolvedValue({ kind: "no_intent" });

    const result = await service.decide(buildContext({ body: "hello there" }));
    expect(result.enqueueOutbox).toHaveLength(1);
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("collect-details:msg_1");
  });

  it("clears slot memory when user requests reset", async () => {
    const result = await service.decide(buildContext({ body: "start over" }));
    expect(searchSlotMemoryService.clear).toHaveBeenCalledWith("conv_1");
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("reset-ack:msg_1");
    expect(toolExecutorService.searchVehiclesFromMessage).not.toHaveBeenCalled();
  });
});
