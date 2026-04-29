import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, WhatsAppMessageKind, WhatsAppOutboxStatus } from "@prisma/client";
import type { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import twilio, { Twilio } from "twilio";
import type { MessageInstance } from "twilio/lib/rest/api/v2010/account/message";
import { PROCESS_WHATSAPP_OUTBOX_JOB, WHATSAPP_AGENT_QUEUE } from "../../../config/constants";
import type { EnvConfig } from "../../../config/env.config";
import {
  computeOutboxRetryDelayMs,
  WHATSAPP_OUTBOX_MAX_ATTEMPTS,
  WHATSAPP_OUTBOX_QUEUE_JOB_OPTIONS,
} from "../booking-agent.const";
import {
  WhatsAppOutboundMessageEmptyException,
  WhatsAppOutboundOutboxIdMissingException,
  WhatsAppOutboundTemplateInvalidException,
} from "../booking-agent.error";
import type { CreateOutboxInput, ProcessWhatsAppOutboxJobData } from "../booking-agent.interface";
import { WhatsAppPersistenceService } from "./whatsapp-persistence.service";

@Injectable()
export class WhatsAppSenderService {
  private readonly twilioClient: Twilio;
  private readonly whatsAppNumber: string;

  constructor(
    private readonly persistenceService: WhatsAppPersistenceService,
    private readonly configService: ConfigService<EnvConfig>,
    private readonly logger: PinoLogger,
    @InjectQueue(WHATSAPP_AGENT_QUEUE)
    private readonly whatsappAgentQueue: Queue<ProcessWhatsAppOutboxJobData>,
  ) {
    this.logger.setContext(WhatsAppSenderService.name);
    const accountSid = this.configService.get("TWILIO_ACCOUNT_SID", { infer: true });
    const authToken = this.configService.get("TWILIO_AUTH_TOKEN", { infer: true });
    this.whatsAppNumber = this.configService.get("TWILIO_WHATSAPP_NUMBER", { infer: true });
    this.twilioClient = twilio(accountSid, authToken);
  }

  async enqueueOutbound(input: CreateOutboxInput): Promise<void> {
    let outboxId: string | null = null;

    try {
      const outbox = await this.persistenceService.createOutboundOutbox(
        input,
        WHATSAPP_OUTBOX_MAX_ATTEMPTS,
      );
      outboxId = outbox.id;
    } catch (error) {
      if (this.persistenceService.isUniqueViolation(error)) {
        this.logger.debug({ dedupeKey: input.dedupeKey }, "Skipping duplicate outbound enqueue");
        return;
      }
      throw error;
    }

    if (!outboxId) {
      throw new WhatsAppOutboundOutboxIdMissingException();
    }

    try {
      await this.whatsappAgentQueue.add(
        PROCESS_WHATSAPP_OUTBOX_JOB,
        { outboxId },
        {
          ...WHATSAPP_OUTBOX_QUEUE_JOB_OPTIONS,
          jobId: `whatsapp-outbox_${outboxId}`,
        },
      );
    } catch (error) {
      try {
        await this.persistenceService.deleteOutbox(outboxId);
      } catch (cleanupError) {
        this.logger.error(
          {
            outboxId,
            dedupeKey: input.dedupeKey,
            cleanupError:
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          },
          "Failed to cleanup outbound outbox record after queue failure",
        );
      }
      throw error;
    }
  }

  async processOutbox(outboxId: string): Promise<void> {
    const claimTime = new Date();
    const claimed = await this.persistenceService.claimOutboxForProcessing(outboxId, claimTime);
    if (!claimed) {
      return;
    }

    const outbox = await this.persistenceService.getOutboxForDispatch(outboxId);
    if (!outbox) {
      this.logger.warn({ outboxId }, "Claimed outbox record missing for dispatch");
      return;
    }

    const attemptsMade = outbox.attempts;

    try {
      const providerMessage = await this.sendViaTwilio(outbox.conversation.phoneE164, outbox);
      const sentAt = new Date();
      await this.markOutboxSent(outbox, providerMessage, sentAt);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isDeadLetter = attemptsMade >= outbox.maxAttempts;
      await this.persistenceService.markOutboxFailed(
        outbox.id,
        isDeadLetter ? WhatsAppOutboxStatus.DEAD_LETTER : WhatsAppOutboxStatus.FAILED,
        errorMessage,
        isDeadLetter
          ? outbox.nextAttemptAt
          : new Date(claimTime.getTime() + computeOutboxRetryDelayMs(attemptsMade)),
      );

      if (!isDeadLetter) {
        throw error;
      }

      this.logger.error(
        {
          outboxId: outbox.id,
          attemptsMade,
        },
        "Outbox moved to dead-letter after max attempts",
      );
    }
  }

  private async sendViaTwilio(
    toPhoneE164: string,
    outbox: {
      id: string;
      mode: string;
      textBody: string | null;
      mediaUrl: string | null;
      templateName: string | null;
      templateVariables: Prisma.JsonValue | null;
    },
  ): Promise<MessageInstance> {
    if (outbox.mode === "TEMPLATE") {
      if (!outbox.templateName?.startsWith("HX")) {
        throw new WhatsAppOutboundTemplateInvalidException();
      }

      const variables =
        outbox.templateVariables && typeof outbox.templateVariables === "object"
          ? JSON.stringify(outbox.templateVariables)
          : undefined;
      const variableKeys = this.extractTemplateVariableKeys(outbox.templateVariables);

      this.logger.info(
        {
          outboxId: outbox.id,
          contentSid: outbox.templateName,
          variablesPresent: variableKeys.length > 0,
          variableKeys,
          maskedPhone: this.maskPhoneForLogs(toPhoneE164),
        },
        "Sending WhatsApp template via Twilio",
      );

      return this.twilioClient.messages.create({
        to: `whatsapp:${toPhoneE164}`,
        from: `whatsapp:${this.whatsAppNumber}`,
        contentSid: outbox.templateName,
        ...(variables ? { contentVariables: variables } : {}),
      });
    }

    if (!outbox.textBody && !outbox.mediaUrl) {
      throw new WhatsAppOutboundMessageEmptyException(outbox.id);
    }

    return this.twilioClient.messages.create({
      to: `whatsapp:${toPhoneE164}`,
      from: `whatsapp:${this.whatsAppNumber}`,
      ...(outbox.textBody ? { body: outbox.textBody } : {}),
      ...(outbox.mediaUrl ? { mediaUrl: [outbox.mediaUrl] } : {}),
    });
  }

  private async markOutboxSent(
    outbox: {
      id: string;
      conversationId: string;
      textBody: string | null;
      mediaUrl: string | null;
    },
    providerMessage: MessageInstance,
    sentAt: Date,
  ): Promise<void> {
    await this.persistenceService.markOutboxSent({
      outboxId: outbox.id,
      conversationId: outbox.conversationId,
      textBody: outbox.textBody,
      mediaUrl: outbox.mediaUrl,
      kind: this.deriveOutboundMessageKind(outbox),
      providerMessage,
      sentAt,
    });
  }

  private deriveOutboundMessageKind(outbox: {
    mediaUrl: string | null;
    textBody: string | null;
  }): WhatsAppMessageKind {
    if (outbox.mediaUrl) {
      return WhatsAppMessageKind.IMAGE;
    }
    if (outbox.textBody?.trim()) {
      return WhatsAppMessageKind.TEXT;
    }
    return WhatsAppMessageKind.UNKNOWN;
  }

  private extractTemplateVariableKeys(templateVariables: unknown): string[] {
    if (
      !templateVariables ||
      typeof templateVariables !== "object" ||
      Array.isArray(templateVariables)
    ) {
      return [];
    }

    return Object.keys(templateVariables);
  }

  private maskPhoneForLogs(phone: string): string {
    const digitsOnly = phone.replaceAll(/\D/g, "");
    if (!digitsOnly) {
      return "***";
    }
    const last4 = digitsOnly.slice(-4);
    return `*****${last4}`;
  }
}
