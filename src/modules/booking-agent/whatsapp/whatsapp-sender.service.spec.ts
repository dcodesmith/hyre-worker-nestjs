import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { WhatsAppMessageKind, WhatsAppOutboxStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WHATSAPP_AGENT_QUEUE } from "../../../config/constants";
import { WhatsAppPersistenceService } from "./whatsapp-persistence.service";
import { WhatsAppSenderService } from "./whatsapp-sender.service";

type SenderTestInternals = {
  sendViaTwilio: (toPhoneE164: string, outbox: Record<string, unknown>) => Promise<unknown>;
};

describe("WhatsAppSenderService", () => {
  let moduleRef: TestingModule;
  let service: WhatsAppSenderService;
  let persistenceService: {
    createOutboundOutbox: ReturnType<typeof vi.fn>;
    deleteOutbox: ReturnType<typeof vi.fn>;
    isUniqueViolation: ReturnType<typeof vi.fn>;
    claimOutboxForProcessing: ReturnType<typeof vi.fn>;
    getOutboxForDispatch: ReturnType<typeof vi.fn>;
    markOutboxFailed: ReturnType<typeof vi.fn>;
    markOutboxSent: ReturnType<typeof vi.fn>;
  };
  let whatsappAgentQueue: { add: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    persistenceService = {
      createOutboundOutbox: vi.fn(),
      deleteOutbox: vi.fn(),
      isUniqueViolation: vi.fn().mockReturnValue(false),
      claimOutboxForProcessing: vi.fn(),
      getOutboxForDispatch: vi.fn(),
      markOutboxFailed: vi.fn(),
      markOutboxSent: vi.fn(),
    };
    const configService = {
      get: vi.fn((key: string) => {
        if (key === "TWILIO_ACCOUNT_SID") return "AC123";
        if (key === "TWILIO_AUTH_TOKEN") return "token";
        if (key === "TWILIO_WHATSAPP_NUMBER") return "+14155238886";
        return "";
      }),
    };
    whatsappAgentQueue = {
      add: vi.fn(),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppSenderService,
        {
          provide: WhatsAppPersistenceService,
          useValue: persistenceService,
        },
        {
          provide: ConfigService,
          useValue: configService,
        },
        {
          provide: getQueueToken(WHATSAPP_AGENT_QUEUE),
          useValue: whatsappAgentQueue,
        },
      ],
    }).compile();

    service = moduleRef.get(WhatsAppSenderService);
  });

  it("skips duplicate outbox enqueue", async () => {
    persistenceService.createOutboundOutbox.mockRejectedValue(new Error("duplicate"));
    persistenceService.isUniqueViolation.mockReturnValue(true);

    await service.enqueueOutbound({
      conversationId: "conv-1",
      dedupeKey: "dedupe-1",
      mode: "FREE_FORM",
      textBody: "hello",
    });

    expect(whatsappAgentQueue.add).not.toHaveBeenCalled();
  });

  it("returns early when outbox claim fails", async () => {
    persistenceService.claimOutboxForProcessing.mockResolvedValue(false);

    await service.processOutbox("outbox-1");

    expect(persistenceService.getOutboxForDispatch).not.toHaveBeenCalled();
  });

  it("marks dead letter on final attempt failure", async () => {
    persistenceService.claimOutboxForProcessing.mockResolvedValue(true);
    persistenceService.getOutboxForDispatch.mockResolvedValue({
      id: "outbox-1",
      conversationId: "conv-1",
      mode: "FREEFORM",
      textBody: "hello",
      mediaUrl: null,
      templateName: null,
      templateVariables: null,
      conversation: { phoneE164: "+2348012345678" },
      attempts: 3,
      maxAttempts: 3,
      nextAttemptAt: null,
    });

    const sendSpy = vi
      .spyOn(service as unknown as SenderTestInternals, "sendViaTwilio")
      .mockRejectedValueOnce(new Error("twilio down"));

    await service.processOutbox("outbox-1");

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(persistenceService.markOutboxFailed).toHaveBeenCalledWith(
      "outbox-1",
      WhatsAppOutboxStatus.DEAD_LETTER,
      "twilio down",
      null,
    );
  });

  it("marks outbox sent when provider send succeeds", async () => {
    persistenceService.claimOutboxForProcessing.mockResolvedValue(true);
    persistenceService.getOutboxForDispatch.mockResolvedValue({
      id: "outbox-2",
      conversationId: "conv-2",
      mode: "FREEFORM",
      textBody: "hello",
      mediaUrl: null,
      templateName: null,
      templateVariables: null,
      conversation: { phoneE164: "+2348012345678" },
      attempts: 1,
      maxAttempts: 3,
      nextAttemptAt: null,
    });
    vi.spyOn(service as unknown as SenderTestInternals, "sendViaTwilio").mockResolvedValueOnce({
      sid: "SM123",
      status: "queued",
      errorCode: null,
      errorMessage: null,
      dateCreated: new Date("2026-03-01T00:00:00.000Z"),
      dateUpdated: new Date("2026-03-01T00:00:00.000Z"),
    });

    await service.processOutbox("outbox-2");

    expect(persistenceService.markOutboxSent).toHaveBeenCalledWith(
      expect.objectContaining({
        outboxId: "outbox-2",
        conversationId: "conv-2",
        kind: WhatsAppMessageKind.TEXT,
      }),
    );
  });
});
