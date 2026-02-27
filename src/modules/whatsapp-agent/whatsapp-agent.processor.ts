import { randomUUID } from "node:crypto";
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Job } from "bullmq";
import {
  PROCESS_WHATSAPP_INBOUND_JOB,
  PROCESS_WHATSAPP_OUTBOX_JOB,
  WHATSAPP_AGENT_QUEUE,
} from "../../config/constants";
import {
  WHATSAPP_LOCK_ACQUIRE_INITIAL_BACKOFF_MS,
  WHATSAPP_LOCK_ACQUIRE_JITTER_MS,
  WHATSAPP_LOCK_ACQUIRE_MAX_BACKOFF_MS,
  WHATSAPP_LOCK_ACQUIRE_MAX_WAIT_MS,
} from "./whatsapp-agent.const";
import {
  WhatsAppAgentUnknownJobTypeException,
  WhatsAppProcessingLockAcquireFailedException,
} from "./whatsapp-agent.error";
import type {
  InboundMessageContext,
  ProcessWhatsAppInboundJobData,
  ProcessWhatsAppOutboxJobData,
} from "./whatsapp-agent.interface";
import { WhatsAppConversationService } from "./whatsapp-conversation.service";
import { WhatsAppOrchestratorService } from "./whatsapp-orchestrator.service";
import { WhatsAppSearchSlotMemoryService } from "./whatsapp-search-slot-memory.service";
import { WhatsAppSenderService } from "./whatsapp-sender.service";

type WhatsAppAgentJobData = ProcessWhatsAppInboundJobData | ProcessWhatsAppOutboxJobData;

@Injectable()
@Processor(WHATSAPP_AGENT_QUEUE, { concurrency: 10 })
export class WhatsAppAgentProcessor extends WorkerHost {
  private readonly logger = new Logger(WhatsAppAgentProcessor.name);

  constructor(
    private readonly conversationService: WhatsAppConversationService,
    private readonly orchestratorService: WhatsAppOrchestratorService,
    private readonly senderService: WhatsAppSenderService,
    private readonly searchSlotMemoryService: WhatsAppSearchSlotMemoryService,
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
      const context = await this.conversationService.getInboundMessageContext(messageId);
      if (!context) {
        return;
      }

      const orchestratorContext: InboundMessageContext & { windowExpiresAt?: Date | null } = {
        messageId: context.id,
        conversationId: context.conversationId,
        body: context.body ?? undefined,
        kind: context.kind,
        windowExpiresAt: context.conversation.windowExpiresAt,
      };

      const result = await this.orchestratorService.decide(orchestratorContext);

      for (const outbound of result.enqueueOutbox) {
        await this.senderService.enqueueOutbound(outbound);
      }

      if (result.markAsHandoff) {
        await this.conversationService.markConversationHandoff(
          context.conversationId,
          result.markAsHandoff.reason,
        );
        try {
          await this.searchSlotMemoryService.clear(context.conversationId);
        } catch (error) {
          this.logger.warn("Failed to clear search slot memory after handoff", {
            conversationId: context.conversationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await this.conversationService.markInboundMessageProcessed(messageId);
      this.logger.log("Processed inbound WhatsApp message", {
        traceId,
        outboundCount: result.enqueueOutbox.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.conversationService.markInboundMessageFailed(messageId, errorMessage);
      this.logger.warn("Failed processing inbound WhatsApp message", {
        traceId,
        durationMs: Date.now() - startedAt,
        error: errorMessage,
      });
      throw error;
    } finally {
      await this.conversationService.releaseProcessingLock(conversationId, lockToken);
    }
  }

  private async acquireProcessingLockWithBackoff(
    conversationId: string,
    lockToken: string,
  ): Promise<boolean> {
    const startedAt = Date.now();
    let delayMs = WHATSAPP_LOCK_ACQUIRE_INITIAL_BACKOFF_MS;

    while (Date.now() - startedAt < WHATSAPP_LOCK_ACQUIRE_MAX_WAIT_MS) {
      const lockAcquired = await this.conversationService.acquireProcessingLock(
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
    if (!job) {
      this.logger.error("WhatsApp agent job failed without context", { error: error.message });
      return;
    }
    this.logger.error(`WhatsApp agent job failed: ${job.name} [${job.id}]`, {
      error: error.message,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts,
    });
  }
}
