import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WHATSAPP_AGENT_QUEUE } from "../../../config/constants";
import { BookingAgentWindowPolicyService } from "../booking-agent-window-policy.service";
import { WhatsAppIngressService } from "./whatsapp-ingress.service";
import { WhatsAppPersistenceService } from "./whatsapp-persistence.service";

describe("WhatsAppIngressService", () => {
  let moduleRef: TestingModule;
  let service: WhatsAppIngressService;
  let persistenceService: {
    upsertConversationForInbound: ReturnType<typeof vi.fn>;
    createInboundMessage: ReturnType<typeof vi.fn>;
    deleteInboundMessage: ReturnType<typeof vi.fn>;
    markInboundMessageQueued: ReturnType<typeof vi.fn>;
    isUniqueViolation: ReturnType<typeof vi.fn>;
  };
  let whatsappAgentQueue: { add: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    persistenceService = {
      upsertConversationForInbound: vi.fn(),
      createInboundMessage: vi.fn(),
      deleteInboundMessage: vi.fn(),
      markInboundMessageQueued: vi.fn(),
      isUniqueViolation: vi.fn().mockReturnValue(false),
    };
    const windowPolicyService = {
      computeWindowExpiry: vi.fn().mockReturnValue(new Date("2026-03-02T00:00:00.000Z")),
    };
    whatsappAgentQueue = {
      add: vi.fn(),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppIngressService,
        {
          provide: WhatsAppPersistenceService,
          useValue: persistenceService,
        },
        {
          provide: BookingAgentWindowPolicyService,
          useValue: windowPolicyService,
        },
        {
          provide: getQueueToken(WHATSAPP_AGENT_QUEUE),
          useValue: whatsappAgentQueue,
        },
      ],
    }).compile();

    service = moduleRef.get(WhatsAppIngressService);
  });

  it("skips status callback payloads", async () => {
    await service.handleInbound({
      MessageStatus: "delivered",
      From: "whatsapp:+2348012345678",
    });

    expect(persistenceService.upsertConversationForInbound).not.toHaveBeenCalled();
    expect(whatsappAgentQueue.add).not.toHaveBeenCalled();
  });

  it("ignores duplicate inbound messages", async () => {
    persistenceService.upsertConversationForInbound.mockResolvedValue({ id: "conv-1" });
    persistenceService.createInboundMessage.mockRejectedValue(new Error("duplicate"));
    persistenceService.isUniqueViolation.mockReturnValue(true);

    await service.handleInbound({
      From: "whatsapp:+2348012345678",
      MessageSid: "SM123",
      Body: "hello",
      NumMedia: "0",
    });

    expect(whatsappAgentQueue.add).not.toHaveBeenCalled();
    expect(persistenceService.markInboundMessageQueued).not.toHaveBeenCalled();
  });

  it("cleans up inbound message when queue enqueue fails", async () => {
    persistenceService.upsertConversationForInbound.mockResolvedValue({ id: "conv-1" });
    persistenceService.createInboundMessage.mockResolvedValue({ id: "msg-1" });
    whatsappAgentQueue.add.mockRejectedValue(new Error("queue down"));

    await expect(
      service.handleInbound({
        From: "whatsapp:+2348012345678",
        MessageSid: "SM999",
        Body: "book me a ride",
        NumMedia: "0",
      }),
    ).rejects.toThrow("queue down");

    expect(persistenceService.deleteInboundMessage).toHaveBeenCalledWith("msg-1");
  });
});
