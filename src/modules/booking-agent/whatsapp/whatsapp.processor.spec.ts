import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { WhatsAppDeliveryMode, WhatsAppMessageKind } from "@prisma/client";
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROCESS_WHATSAPP_INACTIVITY_CLEAR_JOB,
  PROCESS_WHATSAPP_INACTIVITY_NUDGE_JOB,
  PROCESS_WHATSAPP_INBOUND_JOB,
  WHATSAPP_AGENT_QUEUE,
} from "../../../config/constants";
import { WhatsAppProcessingLockAcquireFailedException } from "../booking-agent.error";
import type {
  ProcessWhatsAppInactivityClearJobData,
  ProcessWhatsAppInactivityNudgeJobData,
  ProcessWhatsAppInboundJobData,
  ProcessWhatsAppOutboxJobData,
} from "../booking-agent.interface";
import { BookingAgentOrchestratorService } from "../booking-agent-orchestrator.service";
import { LangGraphStateService } from "../langgraph/langgraph-state.service";
import { WhatsAppProcessor } from "./whatsapp.processor";
import { WhatsAppAudioTranscriptionService } from "./whatsapp-audio-transcription.service";
import { WhatsAppPersistenceService } from "./whatsapp-persistence.service";
import { WhatsAppSenderService } from "./whatsapp-sender.service";

type ProcessorTestInternals = {
  acquireProcessingLockWithBackoff: (conversationId: string, lockToken: string) => Promise<boolean>;
};

type WhatsAppAgentJobData =
  | ProcessWhatsAppInboundJobData
  | ProcessWhatsAppOutboxJobData
  | ProcessWhatsAppInactivityNudgeJobData
  | ProcessWhatsAppInactivityClearJobData;

function buildJob(
  name: string,
  data: WhatsAppAgentJobData,
): Job<WhatsAppAgentJobData, unknown, string> {
  return { name, data } as unknown as Job<WhatsAppAgentJobData, unknown, string>;
}

describe("WhatsAppProcessor", () => {
  let moduleRef: TestingModule;
  let processor: WhatsAppProcessor;
  let persistenceService: {
    acquireProcessingLock: ReturnType<typeof vi.fn>;
    getConversationActivity: ReturnType<typeof vi.fn>;
    getInboundMessageContext: ReturnType<typeof vi.fn>;
    markConversationHandoff: ReturnType<typeof vi.fn>;
    markInboundMessageProcessed: ReturnType<typeof vi.fn>;
    markInboundMessageFailed: ReturnType<typeof vi.fn>;
    releaseProcessingLock: ReturnType<typeof vi.fn>;
  };
  let orchestratorService: {
    decide: ReturnType<typeof vi.fn>;
  };
  let langGraphStateService: {
    loadState: ReturnType<typeof vi.fn>;
    clearState: ReturnType<typeof vi.fn>;
  };
  let senderService: {
    enqueueOutbound: ReturnType<typeof vi.fn>;
    processOutbox: ReturnType<typeof vi.fn>;
  };
  let audioTranscriptionService: {
    transcribeInboundAudio: ReturnType<typeof vi.fn>;
  };
  let whatsappAgentQueue: {
    add: ReturnType<typeof vi.fn>;
    getJob: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    persistenceService = {
      acquireProcessingLock: vi.fn(),
      getConversationActivity: vi.fn(),
      getInboundMessageContext: vi.fn(),
      markConversationHandoff: vi.fn(),
      markInboundMessageProcessed: vi.fn(),
      markInboundMessageFailed: vi.fn(),
      releaseProcessingLock: vi.fn(),
    };
    orchestratorService = {
      decide: vi.fn(),
    };
    langGraphStateService = {
      loadState: vi.fn(),
      clearState: vi.fn(),
    };
    senderService = {
      enqueueOutbound: vi.fn(),
      processOutbox: vi.fn(),
    };
    audioTranscriptionService = {
      transcribeInboundAudio: vi.fn(),
    };
    whatsappAgentQueue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(null),
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
          provide: LangGraphStateService,
          useValue: langGraphStateService,
        },
        {
          provide: WhatsAppSenderService,
          useValue: senderService,
        },
        {
          provide: WhatsAppAudioTranscriptionService,
          useValue: audioTranscriptionService,
        },
        {
          provide: getQueueToken(WHATSAPP_AGENT_QUEUE),
          useValue: whatsappAgentQueue,
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
      processor.process(
        buildJob(PROCESS_WHATSAPP_INBOUND_JOB, {
          conversationId: "conv-1",
          messageId: "msg-1",
          dedupeKey: "dedupe-1",
        }),
      ),
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
        {
          conversationId: "conv-1",
          dedupeKey: "out-1",
          mode: WhatsAppDeliveryMode.FREE_FORM,
          textBody: "ok",
        },
      ],
      markAsHandoff: { reason: "USER_REQUESTED_AGENT" },
      resultingStage: "collecting",
    });

    await processor.process(
      buildJob(PROCESS_WHATSAPP_INBOUND_JOB, {
        conversationId: "conv-1",
        messageId: "msg-1",
        dedupeKey: "dedupe-1",
      }),
    );

    expect(senderService.enqueueOutbound).toHaveBeenCalledTimes(1);
    expect(persistenceService.markConversationHandoff).toHaveBeenCalledWith(
      "conv-1",
      "USER_REQUESTED_AGENT",
    );
    expect(whatsappAgentQueue.add).not.toHaveBeenCalledWith(
      PROCESS_WHATSAPP_INACTIVITY_NUDGE_JOB,
      expect.anything(),
      expect.anything(),
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
      processor.process(
        buildJob(PROCESS_WHATSAPP_INBOUND_JOB, {
          conversationId: "conv-1",
          messageId: "msg-1",
          dedupeKey: "dedupe-1",
        }),
      ),
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
      resultingStage: "collecting",
    });

    await processor.process(
      buildJob(PROCESS_WHATSAPP_INBOUND_JOB, {
        conversationId: "conv-1",
        messageId: "msg-1",
        dedupeKey: "dedupe-1",
      }),
    );

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
      resultingStage: "collecting",
    });

    await processor.process(
      buildJob(PROCESS_WHATSAPP_INBOUND_JOB, {
        conversationId: "conv-1",
        messageId: "msg-1",
        dedupeKey: "dedupe-1",
      }),
    );

    expect(orchestratorService.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        body: undefined,
        kind: WhatsAppMessageKind.AUDIO,
      }),
    );
  });

  it("schedules inactivity nudge after nudgeable stage response", async () => {
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
      enqueueOutbox: [],
      resultingStage: "awaiting_payment",
    });

    await processor.process(
      buildJob(PROCESS_WHATSAPP_INBOUND_JOB, {
        conversationId: "conv-1",
        messageId: "msg-1",
        dedupeKey: "dedupe-1",
      }),
    );

    expect(whatsappAgentQueue.add).toHaveBeenCalledWith(
      PROCESS_WHATSAPP_INACTIVITY_NUDGE_JOB,
      expect.objectContaining({
        conversationId: "conv-1",
        messageId: "msg-1",
      }),
      expect.objectContaining({
        jobId: "whatsapp-inactivity-nudge_conv-1",
        delay: 10 * 60 * 1000,
      }),
    );
  });

  it("schedules inactivity nudge when resulting stage is collecting", async () => {
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
      enqueueOutbox: [],
      resultingStage: "collecting",
    });

    await processor.process(
      buildJob(PROCESS_WHATSAPP_INBOUND_JOB, {
        conversationId: "conv-1",
        messageId: "msg-1",
        dedupeKey: "dedupe-1",
      }),
    );

    expect(whatsappAgentQueue.add).toHaveBeenCalledWith(
      PROCESS_WHATSAPP_INACTIVITY_NUDGE_JOB,
      expect.objectContaining({
        conversationId: "conv-1",
        messageId: "msg-1",
      }),
      expect.objectContaining({
        jobId: "whatsapp-inactivity-nudge_conv-1",
        delay: 10 * 60 * 1000,
      }),
    );
  });

  it("cancels pending inactivity jobs when a new inbound message arrives", async () => {
    const removeNudge = vi.fn().mockResolvedValue(undefined);
    const removeClear = vi.fn().mockResolvedValue(undefined);
    whatsappAgentQueue.getJob
      .mockResolvedValueOnce({ remove: removeNudge })
      .mockResolvedValueOnce({ remove: removeClear });

    persistenceService.acquireProcessingLock.mockResolvedValue(true);
    persistenceService.getInboundMessageContext.mockResolvedValue({
      id: "msg-1",
      conversationId: "conv-1",
      body: "hello",
      kind: WhatsAppMessageKind.TEXT,
      mediaUrl: null,
      mediaContentType: null,
      rawPayload: {},
      conversation: { windowExpiresAt: null },
    });
    orchestratorService.decide.mockResolvedValue({
      enqueueOutbox: [],
      resultingStage: "collecting",
    });

    await processor.process(
      buildJob(PROCESS_WHATSAPP_INBOUND_JOB, {
        conversationId: "conv-1",
        messageId: "msg-1",
        dedupeKey: "dedupe-1",
      }),
    );

    expect(whatsappAgentQueue.getJob).toHaveBeenCalledWith("whatsapp-inactivity-nudge_conv-1");
    expect(whatsappAgentQueue.getJob).toHaveBeenCalledWith("whatsapp-inactivity-clear_conv-1");
    expect(removeNudge).toHaveBeenCalledTimes(1);
    expect(removeClear).toHaveBeenCalledTimes(1);
  });

  it("continues inbound processing when removing an inactivity job races with activation", async () => {
    const removeNudge = vi
      .fn()
      .mockRejectedValue(new Error("Could not remove job because it is active"));
    const removeClear = vi.fn().mockResolvedValue(undefined);
    whatsappAgentQueue.getJob
      .mockResolvedValueOnce({ remove: removeNudge })
      .mockResolvedValueOnce({ remove: removeClear });

    persistenceService.acquireProcessingLock.mockResolvedValue(true);
    persistenceService.getInboundMessageContext.mockResolvedValue({
      id: "msg-1",
      conversationId: "conv-1",
      body: "hello",
      kind: WhatsAppMessageKind.TEXT,
      mediaUrl: null,
      mediaContentType: null,
      rawPayload: {},
      conversation: { windowExpiresAt: null },
    });
    orchestratorService.decide.mockResolvedValue({
      enqueueOutbox: [],
      resultingStage: "collecting",
    });

    await expect(
      processor.process(
        buildJob(PROCESS_WHATSAPP_INBOUND_JOB, {
          conversationId: "conv-1",
          messageId: "msg-1",
          dedupeKey: "dedupe-1",
        }),
      ),
    ).resolves.toEqual({ success: true });

    expect(removeNudge).toHaveBeenCalledTimes(1);
    expect(removeClear).toHaveBeenCalledTimes(1);
    expect(persistenceService.markInboundMessageProcessed).toHaveBeenCalledWith("msg-1");
    expect(persistenceService.markInboundMessageFailed).not.toHaveBeenCalled();
  });

  it("processes inactivity nudge job and schedules clear job", async () => {
    langGraphStateService.loadState.mockResolvedValue({ stage: "confirming" });

    await processor.process(
      buildJob(PROCESS_WHATSAPP_INACTIVITY_NUDGE_JOB, {
        conversationId: "conv-1",
        messageId: "msg-1",
        scheduledAtMs: 1000,
      }),
    );

    expect(senderService.enqueueOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        dedupeKey: "inactivity-nudge:conv-1:1000",
        mode: WhatsAppDeliveryMode.FREE_FORM,
      }),
    );
    expect(whatsappAgentQueue.add).toHaveBeenCalledWith(
      PROCESS_WHATSAPP_INACTIVITY_CLEAR_JOB,
      { conversationId: "conv-1", nudgeScheduledAtMs: 1000 },
      expect.objectContaining({
        jobId: "whatsapp-inactivity-clear_conv-1",
        delay: 5 * 60 * 1000,
      }),
    );
  });

  it("clears state when inactivity grace period elapses without reply", async () => {
    persistenceService.getConversationActivity.mockResolvedValue({
      lastInboundAt: new Date(1000),
    });

    await processor.process(
      buildJob(PROCESS_WHATSAPP_INACTIVITY_CLEAR_JOB, {
        conversationId: "conv-1",
        nudgeScheduledAtMs: 1000,
      }),
    );

    expect(langGraphStateService.clearState).toHaveBeenCalledWith("conv-1");
    expect(senderService.enqueueOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        dedupeKey: "inactivity-clear:conv-1:1000",
        mode: WhatsAppDeliveryMode.FREE_FORM,
      }),
    );
  });

  it("does not clear state when user replies during grace period", async () => {
    persistenceService.getConversationActivity.mockResolvedValue({
      lastInboundAt: new Date(3000),
    });

    await processor.process(
      buildJob(PROCESS_WHATSAPP_INACTIVITY_CLEAR_JOB, {
        conversationId: "conv-1",
        nudgeScheduledAtMs: 1000,
      }),
    );

    expect(langGraphStateService.clearState).not.toHaveBeenCalled();
    expect(senderService.enqueueOutbound).not.toHaveBeenCalled();
  });
});
