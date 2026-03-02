import { Injectable, Logger } from "@nestjs/common";
import { Prisma, WhatsAppMessageKind, WhatsAppOutboxStatus } from "@prisma/client";
import type { MessageInstance } from "twilio/lib/rest/api/v2010/account/message";
import { DatabaseService } from "../../database/database.service";
import { WHATSAPP_PROCESSING_LOCK_TTL_MS } from "../booking-agent.const";
import type { CreateOutboxInput, TwilioInboundWebhookPayload } from "../booking-agent.interface";

@Injectable()
export class WhatsAppPersistenceService {
  private readonly logger = new Logger(WhatsAppPersistenceService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async upsertConversationForInbound(input: {
    phoneE164: string;
    payload: TwilioInboundWebhookPayload;
    now: Date;
    windowExpiresAt: Date;
  }): Promise<{ id: string }> {
    const { phoneE164, payload, now, windowExpiresAt } = input;
    return this.databaseService.whatsAppConversation.upsert({
      where: { phoneE164 },
      create: {
        phoneE164,
        waId: payload.WaId ?? null,
        profileName: payload.ProfileName ?? null,
        lastInboundAt: now,
        windowExpiresAt,
      },
      update: {
        waId: payload.WaId ?? undefined,
        profileName: payload.ProfileName ?? undefined,
        lastInboundAt: now,
        windowExpiresAt,
        status: "ACTIVE",
      },
      select: { id: true },
    });
  }

  async createInboundMessage(input: {
    conversationId: string;
    payload: TwilioInboundWebhookPayload;
    dedupeKey: string;
    kind: WhatsAppMessageKind;
    body?: string | null;
    mediaUrl?: string | null;
    mediaContentType?: string | null;
    now: Date;
  }): Promise<{ id: string }> {
    const { conversationId, payload, dedupeKey, kind, body, mediaUrl, mediaContentType, now } =
      input;
    return this.databaseService.whatsAppMessage.create({
      data: {
        conversationId,
        providerMessageSid: payload.MessageSid ?? null,
        dedupeKey,
        direction: "INBOUND",
        kind,
        status: "RECEIVED",
        body: body ?? null,
        mediaUrl: mediaUrl ?? null,
        mediaContentType: mediaContentType ?? null,
        rawPayload: payload as unknown as Prisma.InputJsonValue,
        receivedAt: now,
      },
      select: { id: true },
    });
  }

  async deleteInboundMessage(messageId: string): Promise<void> {
    await this.databaseService.whatsAppMessage.delete({ where: { id: messageId } });
  }

  async createOutboundOutbox(
    input: CreateOutboxInput,
    maxAttempts: number,
  ): Promise<{ id: string }> {
    return this.databaseService.whatsAppOutbox.create({
      data: {
        conversationId: input.conversationId,
        dedupeKey: input.dedupeKey,
        mode: input.mode,
        textBody: input.textBody ?? null,
        mediaUrl: input.mediaUrl ?? null,
        templateName: input.templateName ?? null,
        maxAttempts,
        templateVariables: input.templateVariables
          ? (input.templateVariables as unknown as Prisma.InputJsonValue)
          : undefined,
      },
      select: { id: true },
    });
  }

  async deleteOutbox(outboxId: string): Promise<void> {
    await this.databaseService.whatsAppOutbox.delete({ where: { id: outboxId } });
  }

  async claimOutboxForProcessing(outboxId: string, now: Date): Promise<boolean> {
    const claimResult = await this.databaseService.whatsAppOutbox.updateMany({
      where: {
        id: outboxId,
        providerMessageSid: null,
        OR: [
          { status: WhatsAppOutboxStatus.PENDING },
          { status: WhatsAppOutboxStatus.FAILED, nextAttemptAt: { lte: now } },
        ],
      },
      data: {
        status: WhatsAppOutboxStatus.PROCESSING,
        attempts: { increment: 1 },
        lastAttemptAt: now,
      },
    });

    return claimResult.count === 1;
  }

  async getOutboxForDispatch(outboxId: string) {
    return this.databaseService.whatsAppOutbox.findUnique({
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
  }

  async markOutboxFailed(
    outboxId: string,
    status: WhatsAppOutboxStatus,
    errorMessage: string,
    nextAttemptAt: Date | null,
  ): Promise<void> {
    await this.databaseService.whatsAppOutbox.update({
      where: { id: outboxId },
      data: {
        status,
        failureReason: errorMessage.slice(0, 500),
        nextAttemptAt,
      },
    });
  }

  async markOutboxSent(input: {
    outboxId: string;
    conversationId: string;
    textBody: string | null;
    mediaUrl: string | null;
    kind: WhatsAppMessageKind;
    providerMessage: MessageInstance;
    sentAt: Date;
  }): Promise<void> {
    const { outboxId, conversationId, textBody, mediaUrl, kind, providerMessage, sentAt } = input;
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
        where: { id: outboxId },
        data: {
          status: WhatsAppOutboxStatus.SENT,
          providerMessageSid: providerMessage.sid,
          sentAt,
          failureReason: null,
          nextAttemptAt: sentAt,
        },
      });

      await tx.whatsAppConversation.update({
        where: { id: conversationId },
        data: { lastOutboundAt: sentAt },
      });

      await tx.whatsAppMessage.create({
        data: {
          conversationId,
          providerMessageSid: providerMessage.sid,
          dedupeKey: `outbox:${outboxId}`,
          direction: "OUTBOUND",
          kind,
          status: "SENT",
          body: textBody,
          mediaUrl,
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

  async acquireProcessingLock(
    conversationId: string,
    lockToken: string,
    ttlMs = WHATSAPP_PROCESSING_LOCK_TTL_MS,
  ): Promise<boolean> {
    const now = new Date();
    const lockExpiry = new Date(now.getTime() + ttlMs);

    const updateResult = await this.databaseService.whatsAppConversation.updateMany({
      where: {
        id: conversationId,
        OR: [
          { processingLockExpiresAt: null },
          { processingLockExpiresAt: { lt: now } },
          { processingLockToken: lockToken },
        ],
      },
      data: {
        processingLockToken: lockToken,
        processingLockExpiresAt: lockExpiry,
      },
    });

    return updateResult.count === 1;
  }

  async releaseProcessingLock(conversationId: string, lockToken: string): Promise<void> {
    await this.databaseService.whatsAppConversation.updateMany({
      where: {
        id: conversationId,
        processingLockToken: lockToken,
      },
      data: {
        processingLockToken: null,
        processingLockExpiresAt: null,
      },
    });
  }

  async markInboundMessageQueued(messageId: string): Promise<void> {
    await this.databaseService.whatsAppMessage.update({
      where: { id: messageId },
      data: { status: "QUEUED" },
    });
  }

  async markInboundMessageProcessed(messageId: string): Promise<void> {
    await this.databaseService.whatsAppMessage.update({
      where: { id: messageId },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });
  }

  async markInboundMessageFailed(messageId: string, error: string): Promise<void> {
    await this.databaseService.whatsAppMessage.update({
      where: { id: messageId },
      data: {
        status: "FAILED",
        errorMessage: error.slice(0, 500),
      },
    });
  }

  async getInboundMessageContext(messageId: string) {
    const message = await this.databaseService.whatsAppMessage.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        conversationId: true,
        direction: true,
        kind: true,
        body: true,
        mediaUrl: true,
        mediaContentType: true,
        status: true,
        rawPayload: true,
        conversation: {
          select: {
            id: true,
            phoneE164: true,
            status: true,
            windowExpiresAt: true,
            lastInboundAt: true,
          },
        },
      },
    });

    if (!message) {
      return null;
    }

    if (message.direction !== "INBOUND") {
      this.logger.warn("Non-inbound message was passed to inbound processor", { messageId });
      return null;
    }

    return message;
  }

  async markConversationHandoff(conversationId: string, reason: string): Promise<void> {
    await this.databaseService.whatsAppConversation.update({
      where: { id: conversationId },
      data: {
        status: "HANDOFF",
        handoffReason: reason,
        handoffAt: new Date(),
      },
    });
  }

  isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
}
