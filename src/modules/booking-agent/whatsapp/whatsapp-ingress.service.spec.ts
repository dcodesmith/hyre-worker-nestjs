import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { PinoLogger } from "nestjs-pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
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
  let logger: PinoLogger;
  let config: Record<string, string | undefined>;

  const arrangeAcceptedInbound = () => {
    persistenceService.upsertConversationForInbound.mockResolvedValue({ id: "conv-1" });
    persistenceService.createInboundMessage.mockResolvedValue({ id: "msg-1" });
    whatsappAgentQueue.add.mockResolvedValue(undefined);
  };

  beforeEach(async () => {
    config = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
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
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => config[key]),
          },
        },
        {
          provide: getQueueToken(WHATSAPP_AGENT_QUEUE),
          useValue: whatsappAgentQueue,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = moduleRef.get(WhatsAppIngressService);
    logger = moduleRef.get(PinoLogger);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("does not log an invalid raw phone number", async () => {
    const invalidPhone = "whatsapp:not-a-phone";
    await service.handleInbound({
      From: invalidPhone,
      MessageSid: "SM321",
      Body: "hello",
      NumMedia: "0",
    });

    expect(logger.debug).toHaveBeenCalledWith("Skipping non-customer webhook payload");
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(invalidPhone);
  });

  it("sends the WhatsApp typing indicator with API key credentials", async () => {
    config.TWILIO_API_KEY_SID = "SK123";
    config.TWILIO_API_KEY_SECRET = "api-key-secret";
    arrangeAcceptedInbound();

    await service.handleInbound({
      From: "whatsapp:+2348012345678",
      MessageSid: "SM123",
      Body: "hello",
      NumMedia: "0",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://messaging.twilio.com/v3/Indicators/Typing.json",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Basic U0sxMjM6YXBpLWtleS1zZWNyZXQ=",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: "WHATSAPP",
          messageId: "SM123",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("skips the typing indicator when API key credentials are missing", async () => {
    arrangeAcceptedInbound();

    await service.handleInbound({
      From: "whatsapp:+2348012345678",
      MessageSid: "SM123",
      Body: "hello",
      NumMedia: "0",
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("swallows typing indicator request errors", async () => {
    config.TWILIO_API_KEY_SID = "SK123";
    config.TWILIO_API_KEY_SECRET = "api-key-secret";
    arrangeAcceptedInbound();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));

    await expect(
      service.handleInbound({
        From: "whatsapp:+2348012345678",
        MessageSid: "SM123",
        Body: "hello",
        NumMedia: "0",
      }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ messageSid: "SM123" }),
        "Twilio WhatsApp typing indicator request failed",
      );
    });
  });

  it("swallows non-success typing indicator responses", async () => {
    config.TWILIO_API_KEY_SID = "SK123";
    config.TWILIO_API_KEY_SECRET = "api-key-secret";
    arrangeAcceptedInbound();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      service.handleInbound({
        From: "whatsapp:+2348012345678",
        MessageSid: "SM123",
        Body: "hello",
        NumMedia: "0",
      }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        { messageSid: "SM123", status: 503 },
        "Twilio WhatsApp typing indicator request failed",
      );
    });
  });
});
