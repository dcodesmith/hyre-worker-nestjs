import { randomUUID } from "node:crypto";
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { WhatsAppMessageKind } from "@prisma/client";
import { Job } from "bullmq";
import {
  PROCESS_WHATSAPP_INBOUND_JOB,
  PROCESS_WHATSAPP_OUTBOX_JOB,
  WHATSAPP_AGENT_QUEUE,
} from "../../../config/constants";
import {
  WHATSAPP_LOCK_ACQUIRE_INITIAL_BACKOFF_MS,
  WHATSAPP_LOCK_ACQUIRE_JITTER_MS,
  WHATSAPP_LOCK_ACQUIRE_MAX_BACKOFF_MS,
  WHATSAPP_LOCK_ACQUIRE_MAX_WAIT_MS,
} from "../booking-agent.const";
import {
  WhatsAppAgentUnknownJobTypeException,
  WhatsAppProcessingLockAcquireFailedException,
} from "../booking-agent.error";
import type {
  InboundMessageContext,
  ProcessWhatsAppInboundJobData,
  ProcessWhatsAppOutboxJobData,
} from "../booking-agent.interface";
import { BookingAgentOrchestratorService } from "../booking-agent-orchestrator.service";
import { parseInteractiveReply } from "./whatsapp-agent.utils";
import { WhatsAppAudioTranscriptionService } from "./whatsapp-audio-transcription.service";
import { WhatsAppPersistenceService } from "./whatsapp-persistence.service";
import { WhatsAppSenderService } from "./whatsapp-sender.service";

type WhatsAppAgentJobData = ProcessWhatsAppInboundJobData | ProcessWhatsAppOutboxJobData;

@Injectable()
@Processor(WHATSAPP_AGENT_QUEUE, { concurrency: 10 })
export class WhatsAppProcessor extends WorkerHost {
  private readonly logger = new Logger(WhatsAppProcessor.name);

  constructor(
    private readonly persistenceService: WhatsAppPersistenceService,
    private readonly bookingAgentOrchestratorService: BookingAgentOrchestratorService,
    private readonly senderService: WhatsAppSenderService,
    private readonly audioTranscriptionService: WhatsAppAudioTranscriptionService,
  ) {
    super();
  }

  async process(job: Job<WhatsAppAgentJobData, unknown, string>): Promise<{ success: boolean }> {
    switch (job.name) {
      case PROCESS_WHATSAPP_INBOUND_JOB:
        await this.processInbound(job as Job<ProcessWhatsAppInboundJobData, unknown, string>);
        return { success: true };

      case PROCESS_WHATSAPP_OUTBOX_JOB:
        await this.processOutbox(job as Job<ProcessWhatsAppOutboxJobData, unknown, string>);
        return { success: true };

      default:
        throw new WhatsAppAgentUnknownJobTypeException(job.name);
    }
  }

  private async processInbound(
    job: Job<ProcessWhatsAppInboundJobData, unknown, string>,
  ): Promise<void> {
    const lockToken = randomUUID();
    const { conversationId, messageId } = job.data;
    const startedAt = Date.now();
    const traceId = `${conversationId}:${messageId}`;

    const lockAcquired = await this.acquireProcessingLockWithBackoff(conversationId, lockToken);
    if (!lockAcquired) {
      throw new WhatsAppProcessingLockAcquireFailedException(conversationId);
    }

    try {
      const context = await this.persistenceService.getInboundMessageContext(messageId);
      if (!context) {
        return;
      }

      // Parse interactive reply data from rawPayload if present
      const interactive = parseInteractiveReply(context.rawPayload);
      let inboundBody = context.body ?? undefined;
      let inboundKind = context.kind;

      if (context.kind === WhatsAppMessageKind.AUDIO) {
        try {
          const transcript = await this.audioTranscriptionService.transcribeInboundAudio({
            mediaUrl: context.mediaUrl,
            mediaContentType: context.mediaContentType,
            traceId,
          });
          if (transcript) {
            inboundBody = transcript;
            inboundKind = WhatsAppMessageKind.TEXT;
          }
        } catch (error) {
          this.logger.warn("Audio transcription failed; falling back to media flow", {
            traceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const orchestratorContext: InboundMessageContext & { windowExpiresAt?: Date | null } = {
        messageId: context.id,
        conversationId: context.conversationId,
        body: inboundBody,
        kind: inboundKind,
        windowExpiresAt: context.conversation.windowExpiresAt,
        interactive: interactive ?? undefined,
      };

      const result = await this.bookingAgentOrchestratorService.decide(orchestratorContext);

      for (const outbound of result.enqueueOutbox) {
        await this.senderService.enqueueOutbound(outbound);
      }

      if (result.markAsHandoff) {
        await this.persistenceService.markConversationHandoff(
          context.conversationId,
          result.markAsHandoff.reason,
        );
      }

      await this.persistenceService.markInboundMessageProcessed(messageId);
      this.logger.log("Processed inbound WhatsApp message", {
        traceId,
        outboundCount: result.enqueueOutbox.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.persistenceService.markInboundMessageFailed(messageId, errorMessage);
      this.logger.warn("Failed processing inbound WhatsApp message", {
        traceId,
        durationMs: Date.now() - startedAt,
        error: errorMessage,
      });
      throw error;
    } finally {
      await this.persistenceService.releaseProcessingLock(conversationId, lockToken);
    }
  }

  private async acquireProcessingLockWithBackoff(
    conversationId: string,
    lockToken: string,
  ): Promise<boolean> {
    const startedAt = Date.now();
    let delayMs = WHATSAPP_LOCK_ACQUIRE_INITIAL_BACKOFF_MS;

    while (Date.now() - startedAt < WHATSAPP_LOCK_ACQUIRE_MAX_WAIT_MS) {
      const lockAcquired = await this.persistenceService.acquireProcessingLock(
        conversationId,
        lockToken,
      );
      if (lockAcquired) {
        return true;
      }

      const elapsedMs = Date.now() - startedAt;
      const remainingMs = WHATSAPP_LOCK_ACQUIRE_MAX_WAIT_MS - elapsedMs;
      if (remainingMs <= 0) {
        break;
      }

      const jitterMs = Math.floor(Math.random() * WHATSAPP_LOCK_ACQUIRE_JITTER_MS);
      const sleepMs = Math.min(delayMs + jitterMs, remainingMs);
      await this.sleep(sleepMs);
      delayMs = Math.min(delayMs * 2, WHATSAPP_LOCK_ACQUIRE_MAX_BACKOFF_MS);
    }

    return false;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async processOutbox(
    job: Job<ProcessWhatsAppOutboxJobData, unknown, string>,
  ): Promise<void> {
    await this.senderService.processOutbox(job.data.outboxId);
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<WhatsAppAgentJobData> | undefined, error: Error): void {
    const errorMessage = error.message;
    const errorStack = error.stack;
    if (!job) {
      this.logger.error(`WhatsApp agent job failed without context: ${errorMessage}`, errorStack);
      return;
    }
    this.logger.error(
      `WhatsApp agent job failed: ${job.name} [${job.id}] - ${errorMessage}`,
      errorStack,
    );
  }
}
