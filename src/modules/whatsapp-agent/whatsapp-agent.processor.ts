import { randomUUID } from "node:crypto";
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Job } from "bullmq";
import {
  PROCESS_WHATSAPP_INBOUND_JOB,
  PROCESS_WHATSAPP_OUTBOX_JOB,
  WHATSAPP_AGENT_QUEUE,
} from "../../config/constants";
import type {
  InboundMessageContext,
  ProcessWhatsAppInboundJobData,
  ProcessWhatsAppOutboxJobData,
} from "./whatsapp-agent.interface";
import { WhatsAppConversationService } from "./whatsapp-conversation.service";
import { WhatsAppOrchestratorService } from "./whatsapp-orchestrator.service";
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
  ) {
    super();
  }

  async process(job: Job<WhatsAppAgentJobData, unknown, string>): Promise<{ success: boolean }> {
    switch (job.name) {
      case PROCESS_WHATSAPP_INBOUND_JOB:
        await this.processInbound(job as Job<ProcessWhatsAppInboundJobData, unknown, string>);
        return { success: true };

      case PROCESS_WHATSAPP_OUTBOX_JOB:
        // Outbox dispatch worker will be implemented in the next slice.
        return { success: true };

      default:
        throw new Error(`Unknown WhatsApp Agent job type: ${job.name}`);
    }
  }

  private async processInbound(
    job: Job<ProcessWhatsAppInboundJobData, unknown, string>,
  ): Promise<void> {
    const lockToken = randomUUID();
    const { conversationId, messageId } = job.data;

    const lockAcquired = await this.conversationService.acquireProcessingLock(
      conversationId,
      lockToken,
    );
    if (!lockAcquired) {
      throw new Error(`Failed to acquire conversation lock for ${conversationId}`);
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

      const result = this.orchestratorService.decide(orchestratorContext);

      for (const outbound of result.enqueueOutbox) {
        await this.senderService.enqueueOutbound(outbound);
      }

      if (result.markAsHandoff) {
        await this.conversationService.markConversationHandoff(
          context.conversationId,
          result.markAsHandoff.reason,
        );
      }

      await this.conversationService.markInboundMessageProcessed(messageId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.conversationService.markInboundMessageFailed(messageId, errorMessage);
      throw error;
    } finally {
      await this.conversationService.releaseProcessingLock(conversationId, lockToken);
    }
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
