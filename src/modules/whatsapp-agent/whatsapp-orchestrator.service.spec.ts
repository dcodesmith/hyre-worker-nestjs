import { WhatsAppDeliveryMode, WhatsAppMessageKind } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { VehicleSearchToolResult } from "./whatsapp-agent.interface";
import { WhatsAppOrchestratorService } from "./whatsapp-orchestrator.service";

describe("WhatsAppOrchestratorService", () => {
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

  it("routes explicit AGENT request to handoff", async () => {
    const windowPolicyService = {
      resolveOutboundMode: vi.fn().mockReturnValue(WhatsAppDeliveryMode.FREE_FORM),
    };
    const toolExecutorService = {
      searchVehiclesFromMessage: vi.fn(),
    };

    const service = new WhatsAppOrchestratorService(
      windowPolicyService as never,
      toolExecutorService as never,
    );

    const result = await service.decide(buildContext({ body: "agent" }));

    expect(result.markAsHandoff).toEqual({ reason: "USER_REQUESTED_AGENT" });
    expect(result.enqueueOutbox).toHaveLength(1);
    expect(toolExecutorService.searchVehiclesFromMessage).not.toHaveBeenCalled();
  });

  it("returns media fallback for inbound audio/image/doc messages", async () => {
    const windowPolicyService = {
      resolveOutboundMode: vi.fn().mockReturnValue(WhatsAppDeliveryMode.FREE_FORM),
    };
    const toolExecutorService = {
      searchVehiclesFromMessage: vi.fn(),
    };

    const service = new WhatsAppOrchestratorService(
      windowPolicyService as never,
      toolExecutorService as never,
    );

    const result = await service.decide(buildContext({ kind: WhatsAppMessageKind.AUDIO }));
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("media-fallback:msg_1");
    expect(toolExecutorService.searchVehiclesFromMessage).not.toHaveBeenCalled();
  });

  it("builds options list and image messages when tool search returns vehicles", async () => {
    const windowPolicyService = {
      resolveOutboundMode: vi.fn().mockReturnValue(WhatsAppDeliveryMode.FREE_FORM),
    };
    const toolResult: VehicleSearchToolResult = {
      interpretation: "Looking for: white suv",
      extracted: { color: "white", vehicleType: "SUV" },
      options: [
        {
          id: "car_1",
          name: "Toyota Prado",
          color: "White",
          imageUrl: "https://img.example.com/car_1.jpg",
          rates: { day: 65000, night: 70000, fullDay: 110000, airportPickup: 40000 },
        },
        {
          id: "car_2",
          name: "Lexus RX",
          color: "Black",
          imageUrl: null,
          rates: { day: 60000, night: 65000, fullDay: 100000, airportPickup: 38000 },
        },
      ],
    };
    const toolExecutorService = {
      searchVehiclesFromMessage: vi.fn().mockResolvedValue(toolResult),
    };

    const service = new WhatsAppOrchestratorService(
      windowPolicyService as never,
      toolExecutorService as never,
    );

    const result = await service.decide(buildContext());

    expect(toolExecutorService.searchVehiclesFromMessage).toHaveBeenCalledWith(
      "Need an SUV tomorrow",
    );
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("options-list:msg_1");
    expect(result.enqueueOutbox.some((item) => item.dedupeKey === "option-image:msg_1:car_1")).toBe(
      true,
    );
  });

  it("asks for details when model/tool extraction cannot determine search intent", async () => {
    const windowPolicyService = {
      resolveOutboundMode: vi.fn().mockReturnValue(WhatsAppDeliveryMode.FREE_FORM),
    };
    const toolExecutorService = {
      searchVehiclesFromMessage: vi.fn().mockResolvedValue(null),
    };

    const service = new WhatsAppOrchestratorService(
      windowPolicyService as never,
      toolExecutorService as never,
    );

    const result = await service.decide(buildContext({ body: "hello there" }));
    expect(result.enqueueOutbox).toHaveLength(1);
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("collect-details:msg_1");
  });
});
