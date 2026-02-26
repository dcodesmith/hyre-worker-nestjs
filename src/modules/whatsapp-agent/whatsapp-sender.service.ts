import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, WhatsAppMessageKind, WhatsAppOutboxStatus } from "@prisma/client";
import { Queue } from "bullmq";
import twilio, { Twilio } from "twilio";
import type { MessageInstance } from "twilio/lib/rest/api/v2010/account/message";
import { PROCESS_WHATSAPP_OUTBOX_JOB, WHATSAPP_AGENT_QUEUE } from "../../config/constants";
import type { EnvConfig } from "../../config/env.config";
import { DatabaseService } from "../database/database.service";
import {
  computeOutboxRetryDelayMs,
  WHATSAPP_OUTBOX_MAX_ATTEMPTS,
  WHATSAPP_OUTBOX_QUEUE_JOB_OPTIONS,
} from "./whatsapp-agent.const";
import type { CreateOutboxInput, ProcessWhatsAppOutboxJobData } from "./whatsapp-agent.interface";

@Injectable()
export class WhatsAppSenderService {
  private readonly logger = new Logger(WhatsAppSenderService.name);
  private readonly twilioClient: Twilio;
  private readonly whatsAppNumber: string;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService<EnvConfig>,
    @InjectQueue(WHATSAPP_AGENT_QUEUE)
    private readonly whatsappAgentQueue: Queue<ProcessWhatsAppOutboxJobData>,
  ) {
    const accountSid = this.configService.get("TWILIO_ACCOUNT_SID", { infer: true });
    const authToken = this.configService.get("TWILIO_AUTH_TOKEN", { infer: true });
    this.whatsAppNumber = this.configService.get("TWILIO_WHATSAPP_NUMBER", { infer: true });
    this.twilioClient = twilio(accountSid, authToken);
  }

  async enqueueOutbound(input: CreateOutboxInput): Promise<void> {
    let outboxId: string | null = null;

    try {
      const outbox = await this.databaseService.whatsAppOutbox.create({
        data: {
          conversationId: input.conversationId,
          dedupeKey: input.dedupeKey,
          mode: input.mode,
          textBody: input.textBody ?? null,
          mediaUrl: input.mediaUrl ?? null,
          templateName: input.templateName ?? null,
          maxAttempts: WHATSAPP_OUTBOX_MAX_ATTEMPTS,
          templateVariables: input.templateVariables
            ? (input.templateVariables as unknown as Prisma.InputJsonValue)
            : undefined,
        },
        select: { id: true },
      });
      outboxId = outbox.id;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        this.logger.debug("Skipping duplicate outbound enqueue", { dedupeKey: input.dedupeKey });
        return;
      }
      throw error;
    }

    if (!outboxId) {
      throw new Error("Outbound enqueue did not return outbox id");
    }

    try {
      await this.whatsappAgentQueue.add(
        PROCESS_WHATSAPP_OUTBOX_JOB,
        { outboxId },
        {
          ...WHATSAPP_OUTBOX_QUEUE_JOB_OPTIONS,
          jobId: `whatsapp-outbox:${outboxId}`,
        },
      );
    } catch (error) {
      try {
        await this.databaseService.whatsAppOutbox.delete({ where: { id: outboxId } });
      } catch (cleanupError) {
        this.logger.error("Failed to cleanup outbound outbox record after queue failure", {
          outboxId,
          dedupeKey: input.dedupeKey,
          cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    }
  }

  async processOutbox(outboxId: string): Promise<void> {
    const outbox = await this.databaseService.whatsAppOutbox.findUnique({
      where: { id: outboxId },
      select: {
        id: true,
        conversationId: true,
        dedupeKey: true,
        mode: true,
        status: true,
        providerMessageSid: true,
        attempts: true,
        maxAttempts: true,
        textBody: true,
        mediaUrl: true,
        templateName: true,
        templateVariables: true,
        nextAttemptAt: true,
        conversation: { select: { phoneE164: true } },
      },
    });

    if (!outbox) {
      this.logger.warn("Outbox record not found for dispatch", { outboxId });
      return;
    }

    if (
      outbox.status === WhatsAppOutboxStatus.SENT ||
      outbox.status === WhatsAppOutboxStatus.FAILED ||
      outbox.status === WhatsAppOutboxStatus.DEAD_LETTER
    ) {
      return;
    }

    if (outbox.providerMessageSid?.trim()) {
      this.logger.warn("Skipping outbox dispatch because provider message sid already exists", {
        outboxId: outbox.id,
        providerMessageSid: outbox.providerMessageSid,
      });
      return;
    }

    const now = new Date();
    const attemptsMade = outbox.attempts + 1;

    await this.databaseService.whatsAppOutbox.update({
      where: { id: outbox.id },
      data: {
        status: WhatsAppOutboxStatus.PROCESSING,
        attempts: { increment: 1 },
        lastAttemptAt: now,
      },
    });

    try {
      const providerMessage = await this.sendViaTwilio(outbox.conversation.phoneE164, outbox);
      await this.markOutboxSent(outbox, providerMessage, now);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isDeadLetter = attemptsMade >= outbox.maxAttempts;
      await this.databaseService.whatsAppOutbox.update({
        where: { id: outbox.id },
        data: {
          status: isDeadLetter ? WhatsAppOutboxStatus.DEAD_LETTER : WhatsAppOutboxStatus.FAILED,
          failureReason: errorMessage.slice(0, 500),
          nextAttemptAt: isDeadLetter
            ? outbox.nextAttemptAt
            : new Date(now.getTime() + computeOutboxRetryDelayMs(attemptsMade)),
        },
      });

      if (!isDeadLetter) {
        throw error;
      }

      this.logger.error("Outbox moved to dead-letter after max attempts", {
        outboxId: outbox.id,
        attemptsMade,
      });
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
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
        throw new Error(
          "Invalid TEMPLATE: templateName must be a Twilio Content SID starting with 'HX'",
        );
      }

      const variables =
        outbox.templateVariables && typeof outbox.templateVariables === "object"
          ? JSON.stringify(outbox.templateVariables)
          : undefined;

      return this.twilioClient.messages.create({
        to: `whatsapp:${toPhoneE164}`,
        from: `whatsapp:${this.whatsAppNumber}`,
        contentSid: outbox.templateName,
        ...(variables ? { contentVariables: variables } : {}),
      });
    }

    if (!outbox.textBody && !outbox.mediaUrl) {
      throw new Error(`Outbox ${outbox.id} has neither textBody nor mediaUrl`);
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
    const providerPayload = {
      sid: providerMessage.sid,
      status: providerMessage.status,
      errorCode: providerMessage.errorCode ?? null,
      errorMessage: providerMessage.errorMessage ?? null,
      dateCreated: providerMessage.dateCreated?.toISOString() ?? null,
      dateUpdated: providerMessage.dateUpdated?.toISOString() ?? null,
    };

    await this.databaseService.$transaction(async (tx) => {
      await tx.whatsAppOutbox.update({
        where: { id: outbox.id },
        data: {
          status: WhatsAppOutboxStatus.SENT,
          providerMessageSid: providerMessage.sid,
          sentAt,
          failureReason: null,
          nextAttemptAt: sentAt,
        },
      });

      await tx.whatsAppConversation.update({
        where: { id: outbox.conversationId },
        data: { lastOutboundAt: sentAt },
      });

      await tx.whatsAppMessage.create({
        data: {
          conversationId: outbox.conversationId,
          providerMessageSid: providerMessage.sid,
          dedupeKey: `outbox:${outbox.id}`,
          direction: "OUTBOUND",
          kind: this.deriveOutboundMessageKind(outbox),
          status: "SENT",
          body: outbox.textBody,
          mediaUrl: outbox.mediaUrl,
          mediaContentType: null,
          providerStatus: providerMessage.status ?? null,
          errorCode: providerMessage.errorCode ? String(providerMessage.errorCode) : null,
          errorMessage: providerMessage.errorMessage ?? null,
          rawPayload: providerPayload as unknown as Prisma.InputJsonValue,
          receivedAt: sentAt,
          sentAt,
        },
      });
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
}
