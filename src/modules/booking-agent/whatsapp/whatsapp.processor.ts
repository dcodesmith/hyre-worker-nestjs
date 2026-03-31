import { randomInt, randomUUID } from "node:crypto";
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { WhatsAppDeliveryMode, WhatsAppMessageKind } from "@prisma/client";
import { Job, type Queue } from "bullmq";
import {
  PROCESS_WHATSAPP_INACTIVITY_CLEAR_JOB,
  PROCESS_WHATSAPP_INACTIVITY_NUDGE_JOB,
  PROCESS_WHATSAPP_INBOUND_JOB,
  PROCESS_WHATSAPP_OUTBOX_JOB,
  WHATSAPP_AGENT_QUEUE,
} from "../../../config/constants";
import {
  WHATSAPP_INACTIVITY_CLEAR_DELAY_MS,
  WHATSAPP_INACTIVITY_NUDGE_DELAY_MS,
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
  OrchestratorResult,
  ProcessWhatsAppInactivityClearJobData,
  ProcessWhatsAppInactivityNudgeJobData,
  ProcessWhatsAppInboundJobData,
  ProcessWhatsAppOutboxJobData,
} from "../booking-agent.interface";
import { BookingAgentOrchestratorService } from "../booking-agent-orchestrator.service";
import { LangGraphStateService } from "../langgraph/langgraph-state.service";
import { parseInteractiveReply } from "./whatsapp-agent.utils";
import { WhatsAppAudioTranscriptionService } from "./whatsapp-audio-transcription.service";
import type { InboundMessageContextRecord } from "./whatsapp-persistence.service";
import { WhatsAppPersistenceService } from "./whatsapp-persistence.service";
import { WhatsAppSenderService } from "./whatsapp-sender.service";

type WhatsAppAgentJobData =
  | ProcessWhatsAppInboundJobData
  | ProcessWhatsAppOutboxJobData
  | ProcessWhatsAppInactivityNudgeJobData
  | ProcessWhatsAppInactivityClearJobData;

@Injectable()
@Processor(WHATSAPP_AGENT_QUEUE, { concurrency: 10 })
export class WhatsAppProcessor extends WorkerHost {
  private readonly logger = new Logger(WhatsAppProcessor.name);

  constructor(
    private readonly persistenceService: WhatsAppPersistenceService,
    private readonly bookingAgentOrchestratorService: BookingAgentOrchestratorService,
    private readonly langGraphStateService: LangGraphStateService,
    private readonly senderService: WhatsAppSenderService,
    private readonly audioTranscriptionService: WhatsAppAudioTranscriptionService,
    @InjectQueue(WHATSAPP_AGENT_QUEUE)
    private readonly whatsappAgentQueue: Queue<WhatsAppAgentJobData>,
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

      case PROCESS_WHATSAPP_INACTIVITY_NUDGE_JOB:
        await this.processInactivityNudge(
          job as Job<ProcessWhatsAppInactivityNudgeJobData, unknown, string>,
        );
        return { success: true };

      case PROCESS_WHATSAPP_INACTIVITY_CLEAR_JOB:
        await this.processInactivityClear(
          job as Job<ProcessWhatsAppInactivityClearJobData, unknown, string>,
        );
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

      await this.cancelPendingInactivityJobs(conversationId);
      const orchestratorContext = await this.buildOrchestratorContext(context, traceId);

      const result = await this.bookingAgentOrchestratorService.decide(orchestratorContext);
      await this.handleInboundOrchestratorResult(result, context.conversationId, messageId);

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

  private async buildOrchestratorContext(
    context: InboundMessageContextRecord,
    traceId: string,
  ): Promise<InboundMessageContext & { windowExpiresAt?: Date | null }> {
    const interactive = parseInteractiveReply(context.rawPayload);
    const resolvedInbound = await this.resolveInboundMessageContent(context, traceId);

    return {
      messageId: context.id,
      conversationId: context.conversationId,
      body: resolvedInbound.body,
      kind: resolvedInbound.kind,
      windowExpiresAt: context.WhatsAppConversation.windowExpiresAt,
      interactive: interactive ?? undefined,
    };
  }

  private async resolveInboundMessageContent(
    context: InboundMessageContextRecord,
    traceId: string,
  ): Promise<{ body?: string; kind: WhatsAppMessageKind }> {
    if (context.kind !== WhatsAppMessageKind.AUDIO) {
      return { body: context.body ?? undefined, kind: context.kind };
    }

    try {
      const transcript = await this.audioTranscriptionService.transcribeInboundAudio({
        mediaUrl: context.mediaUrl,
        mediaContentType: context.mediaContentType,
        traceId,
      });
      if (!transcript) {
        return { body: context.body ?? undefined, kind: context.kind };
      }

      return { body: transcript, kind: WhatsAppMessageKind.TEXT };
    } catch (error) {
      this.logger.warn("Audio transcription failed; falling back to media flow", {
        traceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { body: context.body ?? undefined, kind: context.kind };
    }
  }

  private async handleInboundOrchestratorResult(
    result: OrchestratorResult,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    for (const outbound of result.enqueueOutbox) {
      await this.senderService.enqueueOutbound(outbound);
    }

    if (result.markAsHandoff) {
      await this.persistenceService.markConversationHandoff(
        conversationId,
        result.markAsHandoff.reason,
      );
    }

    if (!result.markAsHandoff && this.isNudgeableStage(result.resultingStage)) {
      await this.scheduleInactivityNudge(conversationId, messageId);
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

      const jitterMs = randomInt(WHATSAPP_LOCK_ACQUIRE_JITTER_MS);
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

  private async processInactivityNudge(
    job: Job<ProcessWhatsAppInactivityNudgeJobData, unknown, string>,
  ): Promise<void> {
    const { conversationId, messageId, scheduledAtMs } = job.data;
    const state = await this.langGraphStateService.loadState(conversationId);
    if (!this.isNudgeableStage(state?.stage)) {
      return;
    }

    await this.senderService.enqueueOutbound({
      conversationId,
      dedupeKey: `inactivity-nudge:${conversationId}:${scheduledAtMs}`,
      mode: WhatsAppDeliveryMode.FREE_FORM,
      textBody:
        "Still there? Your session will expire in 5 minutes. Reply to continue or your booking details will be cleared.",
      templateName: undefined,
      templateVariables: undefined,
    });

    await this.whatsappAgentQueue.add(
      PROCESS_WHATSAPP_INACTIVITY_CLEAR_JOB,
      { conversationId, nudgeScheduledAtMs: scheduledAtMs },
      {
        jobId: this.getInactivityClearJobId(conversationId),
        delay: WHATSAPP_INACTIVITY_CLEAR_DELAY_MS,
      },
    );

    this.logger.log("Scheduled inactivity clear after nudge", {
      conversationId,
      messageId,
      nudgeScheduledAtMs: scheduledAtMs,
    });
  }

  private async processInactivityClear(
    job: Job<ProcessWhatsAppInactivityClearJobData, unknown, string>,
  ): Promise<void> {
    const { conversationId, nudgeScheduledAtMs } = job.data;
    const activity = await this.persistenceService.getConversationActivity(conversationId);
    const lastInboundMs = activity?.lastInboundAt
      ? new Date(activity.lastInboundAt).getTime()
      : null;

    if (lastInboundMs && lastInboundMs > nudgeScheduledAtMs) {
      this.logger.debug("Skipping inactivity clear because user responded during grace period", {
        conversationId,
        lastInboundMs,
        nudgeScheduledAtMs,
      });
      return;
    }

    await this.langGraphStateService.clearState(conversationId);
    await this.senderService.enqueueOutbound({
      conversationId,
      dedupeKey: `inactivity-clear:${conversationId}:${nudgeScheduledAtMs}`,
      mode: WhatsAppDeliveryMode.FREE_FORM,
      textBody:
        "Your previous booking details have been cleared due to inactivity. Send a message when you're ready to start again.",
      templateName: undefined,
      templateVariables: undefined,
    });

    this.logger.log("Cleared LangGraph state after inactivity grace period elapsed", {
      conversationId,
      nudgeScheduledAtMs,
    });
  }

  private async scheduleInactivityNudge(conversationId: string, messageId: string): Promise<void> {
    const scheduledAtMs = Date.now();
    await this.whatsappAgentQueue.add(
      PROCESS_WHATSAPP_INACTIVITY_NUDGE_JOB,
      {
        conversationId,
        messageId,
        scheduledAtMs,
      },
      {
        jobId: this.getInactivityNudgeJobId(conversationId),
        delay: WHATSAPP_INACTIVITY_NUDGE_DELAY_MS,
      },
    );
  }

  private async cancelPendingInactivityJobs(conversationId: string): Promise<void> {
    const nudgeJob = await this.whatsappAgentQueue.getJob(
      this.getInactivityNudgeJobId(conversationId),
    );
    if (nudgeJob) {
      await this.removeJobSafely(nudgeJob, conversationId);
    }

    const clearJob = await this.whatsappAgentQueue.getJob(
      this.getInactivityClearJobId(conversationId),
    );
    if (clearJob) {
      await this.removeJobSafely(clearJob, conversationId);
    }
  }

  private async removeJobSafely(
    job: Pick<Job, "id" | "name" | "remove">,
    conversationId: string,
  ): Promise<void> {
    try {
      await job.remove();
    } catch (error) {
      if (this.isBullMqActiveRemoveRace(error)) {
        this.logger.debug("Skipping inactivity job removal because it is already active", {
          conversationId,
          jobId: job.id,
          jobName: job.name,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      throw error;
    }
  }

  private isBullMqActiveRemoveRace(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return message.includes("active") || message.includes("locked");
  }

  private isNudgeableStage(stage?: string): boolean {
    return (
      stage === "collecting" ||
      stage === "presenting_options" ||
      stage === "confirming" ||
      stage === "awaiting_payment"
    );
  }

  private getInactivityNudgeJobId(conversationId: string): string {
    return `whatsapp-inactivity-nudge_${conversationId}`;
  }

  private getInactivityClearJobId(conversationId: string): string {
    return `whatsapp-inactivity-clear_${conversationId}`;
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
