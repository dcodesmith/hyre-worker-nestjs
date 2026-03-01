import { Test, type TestingModule } from "@nestjs/testing";
import { WhatsAppMessageKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppProcessingLockAcquireFailedException } from "../booking-agent.error";
import { BookingAgentOrchestratorService } from "../booking-agent-orchestrator.service";
import { WhatsAppProcessor } from "./whatsapp.processor";
import { WhatsAppAudioTranscriptionService } from "./whatsapp-audio-transcription.service";
import { WhatsAppPersistenceService } from "./whatsapp-persistence.service";
import { WhatsAppSenderService } from "./whatsapp-sender.service";

type ProcessorTestInternals = {
  acquireProcessingLockWithBackoff: (conversationId: string, lockToken: string) => Promise<boolean>;
};

describe("WhatsAppProcessor", () => {
  let moduleRef: TestingModule;
  let processor: WhatsAppProcessor;
  let persistenceService: {
    acquireProcessingLock: ReturnType<typeof vi.fn>;
    getInboundMessageContext: ReturnType<typeof vi.fn>;
    markConversationHandoff: ReturnType<typeof vi.fn>;
    markInboundMessageProcessed: ReturnType<typeof vi.fn>;
    markInboundMessageFailed: ReturnType<typeof vi.fn>;
    releaseProcessingLock: ReturnType<typeof vi.fn>;
  };
  let orchestratorService: {
    decide: ReturnType<typeof vi.fn>;
  };
  let senderService: {
    enqueueOutbound: ReturnType<typeof vi.fn>;
    processOutbox: ReturnType<typeof vi.fn>;
  };
  let audioTranscriptionService: {
    transcribeInboundAudio: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    persistenceService = {
      acquireProcessingLock: vi.fn(),
      getInboundMessageContext: vi.fn(),
      markConversationHandoff: vi.fn(),
      markInboundMessageProcessed: vi.fn(),
      markInboundMessageFailed: vi.fn(),
      releaseProcessingLock: vi.fn(),
    };
    orchestratorService = {
      decide: vi.fn(),
    };
    senderService = {
      enqueueOutbound: vi.fn(),
      processOutbox: vi.fn(),
    };
    audioTranscriptionService = {
      transcribeInboundAudio: vi.fn(),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppProcessor,
        {
          provide: WhatsAppPersistenceService,
          useValue: persistenceService,
        },
        {
          provide: BookingAgentOrchestratorService,
          useValue: orchestratorService,
        },
        {
          provide: WhatsAppSenderService,
          useValue: senderService,
        },
        {
          provide: WhatsAppAudioTranscriptionService,
          useValue: audioTranscriptionService,
        },
      ],
    }).compile();

    processor = moduleRef.get(WhatsAppProcessor);
  });

  it("throws when lock cannot be acquired", async () => {
    persistenceService.acquireProcessingLock.mockResolvedValue(false);
    vi.spyOn(
      processor as unknown as ProcessorTestInternals,
      "acquireProcessingLockWithBackoff",
    ).mockResolvedValue(false);

    await expect(
      processor.process({
        name: "process-whatsapp-inbound",
        data: { conversationId: "conv-1", messageId: "msg-1" },
      } as never),
    ).rejects.toBeInstanceOf(WhatsAppProcessingLockAcquireFailedException);
  });

  it("processes inbound flow and releases lock", async () => {
    persistenceService.acquireProcessingLock.mockResolvedValue(true);
    persistenceService.getInboundMessageContext.mockResolvedValue({
      id: "msg-1",
      conversationId: "conv-1",
      body: "book me an suv",
      kind: WhatsAppMessageKind.TEXT,
      mediaUrl: null,
      mediaContentType: null,
      rawPayload: {},
      conversation: { windowExpiresAt: new Date("2026-03-01T00:00:00.000Z") },
    });
    orchestratorService.decide.mockResolvedValue({
      enqueueOutbox: [
        { conversationId: "conv-1", dedupeKey: "out-1", mode: "FREEFORM", textBody: "ok" },
      ],
      markAsHandoff: { reason: "USER_REQUESTED_AGENT" },
    });

    await processor.process({
      name: "process-whatsapp-inbound",
      data: { conversationId: "conv-1", messageId: "msg-1" },
    } as never);

    expect(senderService.enqueueOutbound).toHaveBeenCalledTimes(1);
    expect(persistenceService.markConversationHandoff).toHaveBeenCalledWith(
      "conv-1",
      "USER_REQUESTED_AGENT",
    );
    expect(persistenceService.markInboundMessageProcessed).toHaveBeenCalledWith("msg-1");
    expect(persistenceService.releaseProcessingLock).toHaveBeenCalledWith(
      "conv-1",
      expect.any(String),
    );
  });

  it("marks message failed on orchestrator error and still releases lock", async () => {
    persistenceService.acquireProcessingLock.mockResolvedValue(true);
    persistenceService.getInboundMessageContext.mockResolvedValue({
      id: "msg-1",
      conversationId: "conv-1",
      body: "book me an suv",
      kind: WhatsAppMessageKind.TEXT,
      mediaUrl: null,
      mediaContentType: null,
      rawPayload: {},
      conversation: { windowExpiresAt: new Date("2026-03-01T00:00:00.000Z") },
    });
    orchestratorService.decide.mockRejectedValue(new Error("orchestrator failed"));

    await expect(
      processor.process({
        name: "process-whatsapp-inbound",
        data: { conversationId: "conv-1", messageId: "msg-1" },
      } as never),
    ).rejects.toThrow("orchestrator failed");

    expect(persistenceService.markInboundMessageFailed).toHaveBeenCalledWith(
      "msg-1",
      "orchestrator failed",
    );
    expect(persistenceService.releaseProcessingLock).toHaveBeenCalledWith(
      "conv-1",
      expect.any(String),
    );
  });

  it("transcribes audio and sends transcribed text to orchestrator", async () => {
    persistenceService.acquireProcessingLock.mockResolvedValue(true);
    persistenceService.getInboundMessageContext.mockResolvedValue({
      id: "msg-1",
      conversationId: "conv-1",
      body: null,
      kind: WhatsAppMessageKind.AUDIO,
      mediaUrl: "https://api.twilio.com/media/123",
      mediaContentType: "audio/ogg",
      rawPayload: {},
      conversation: { windowExpiresAt: new Date("2026-03-01T00:00:00.000Z") },
    });
    audioTranscriptionService.transcribeInboundAudio.mockResolvedValue("book a camry tomorrow");
    orchestratorService.decide.mockResolvedValue({
      enqueueOutbox: [],
    });

    await processor.process({
      name: "process-whatsapp-inbound",
      data: { conversationId: "conv-1", messageId: "msg-1" },
    } as never);

    expect(audioTranscriptionService.transcribeInboundAudio).toHaveBeenCalledTimes(1);
    expect(orchestratorService.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "book a camry tomorrow",
        kind: WhatsAppMessageKind.TEXT,
      }),
    );
  });

  it("falls back to audio kind when transcription fails", async () => {
    persistenceService.acquireProcessingLock.mockResolvedValue(true);
    persistenceService.getInboundMessageContext.mockResolvedValue({
      id: "msg-1",
      conversationId: "conv-1",
      body: null,
      kind: WhatsAppMessageKind.AUDIO,
      mediaUrl: "https://api.twilio.com/media/123",
      mediaContentType: "audio/ogg",
      rawPayload: {},
      conversation: { windowExpiresAt: new Date("2026-03-01T00:00:00.000Z") },
    });
    audioTranscriptionService.transcribeInboundAudio.mockRejectedValue(new Error("timeout"));
    orchestratorService.decide.mockResolvedValue({
      enqueueOutbox: [],
    });

    await processor.process({
      name: "process-whatsapp-inbound",
      data: { conversationId: "conv-1", messageId: "msg-1" },
    } as never);

    expect(orchestratorService.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        body: undefined,
        kind: WhatsAppMessageKind.AUDIO,
      }),
    );
  });
});
