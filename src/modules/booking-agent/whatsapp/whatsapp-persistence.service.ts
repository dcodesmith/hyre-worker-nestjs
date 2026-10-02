import { Injectable } from "@nestjs/common";
import {
  Prisma,
  WhatsAppLinkStatus,
  WhatsAppMessageKind,
  WhatsAppOutboxStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import type { MessageInstance } from "twilio/lib/rest/api/v2010/account/message";
import { DatabaseService } from "../../database/database.service";
import {
  WHATSAPP_OUTBOX_PROCESSING_TTL_MS,
  WHATSAPP_PROCESSING_LOCK_TTL_MS,
} from "../booking-agent.const";
import type {
  CreateOutboxInput,
  ProcessWhatsAppAccountLinkNotificationJobData,
  TwilioInboundWebhookPayload,
} from "../booking-agent.interface";

export const INBOUND_MESSAGE_CONTEXT_SELECT = Prisma.validator<Prisma.WhatsAppMessageSelect>()({
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
});

export type InboundMessageContextRecord = Prisma.WhatsAppMessageGetPayload<{
  select: typeof INBOUND_MESSAGE_CONTEXT_SELECT;
}>;

@Injectable()
export class WhatsAppPersistenceService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WhatsAppPersistenceService.name);
  }

  async upsertConversationForInbound(input: {
    phoneE164: string;
    payload: TwilioInboundWebhookPayload;
    now: Date;
    windowExpiresAt: Date;
  }): Promise<{ id: string }> {
    const { phoneE164, payload, now, windowExpiresAt } = input;
    return this.databaseService.$transaction(async (tx) => {
      const conversation = await tx.whatsAppConversation.upsert({
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
        },
        select: { id: true },
      });

      // Reactivate closed chats; never clobber active human handoff.
      await tx.whatsAppConversation.updateMany({
        where: {
          id: conversation.id,
          status: "CLOSED",
        },
        data: { status: "ACTIVE" },
      });

      return conversation;
    });
  }

  async synchronizeConversationIdentity(
    conversationId: string,
    beforeIdentityChange: () => Promise<void>,
  ): Promise<{ userId: string; linkedAt: string } | null> {
    const currentConversation = await this.databaseService.whatsAppConversation.findUnique({
      where: { id: conversationId },
      select: {
        phoneE164: true,
        linkedUserId: true,
        linkStatus: true,
        linkVerifiedAt: true,
        linkNotificationCompletedAt: true,
      },
    });
    if (!currentConversation || currentConversation.linkStatus === WhatsAppLinkStatus.REVOKED) {
      return null;
    }

    const currentVerifiedUser = await this.databaseService.user.findFirst({
      where: {
        phoneNumber: currentConversation.phoneE164,
        phoneVerifiedAt: { not: null },
      },
      select: { id: true },
    });
    const currentLinkedUserId = currentVerifiedUser?.id ?? null;
    const identityWillChange =
      currentConversation.linkedUserId !== currentLinkedUserId ||
      (currentLinkedUserId !== null &&
        currentConversation.linkStatus !== WhatsAppLinkStatus.LINKED);
    if (!identityWillChange) {
      if (
        currentLinkedUserId &&
        currentConversation.linkVerifiedAt &&
        !currentConversation.linkNotificationCompletedAt
      ) {
        return {
          userId: currentLinkedUserId,
          linkedAt: currentConversation.linkVerifiedAt.toISOString(),
        };
      }
      return null;
    }

    // Redis may be slow or unavailable, so clear it before holding the database row lock.
    await beforeIdentityChange();

    return this.databaseService.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "WhatsAppConversation" WHERE id = ${conversationId}::uuid FOR UPDATE`,
      );
      const conversation = await tx.whatsAppConversation.findUnique({
        where: { id: conversationId },
        select: {
          phoneE164: true,
          linkedUserId: true,
          linkStatus: true,
          linkVerifiedAt: true,
          linkNotificationCompletedAt: true,
        },
      });
      if (!conversation || conversation.linkStatus === WhatsAppLinkStatus.REVOKED) {
        return null;
      }

      const verifiedUser = await tx.user.findFirst({
        where: {
          phoneNumber: conversation.phoneE164,
          phoneVerifiedAt: { not: null },
        },
        select: { id: true },
      });
      const nextLinkedUserId = verifiedUser?.id ?? null;
      const identityChanged =
        conversation.linkedUserId !== nextLinkedUserId ||
        (nextLinkedUserId !== null && conversation.linkStatus !== WhatsAppLinkStatus.LINKED);
      if (!identityChanged) {
        if (
          nextLinkedUserId &&
          conversation.linkVerifiedAt &&
          !conversation.linkNotificationCompletedAt
        ) {
          return {
            userId: nextLinkedUserId,
            linkedAt: conversation.linkVerifiedAt.toISOString(),
          };
        }
        return null;
      }

      const linkedAt = new Date();
      await tx.whatsAppConversation.update({
        where: { id: conversationId },
        data: verifiedUser
          ? {
              linkedUserId: verifiedUser.id,
              linkStatus: WhatsAppLinkStatus.LINKED,
              linkVerifiedAt: linkedAt,
              linkNotificationCompletedAt: null,
            }
          : {
              linkedUserId: null,
              linkStatus: WhatsAppLinkStatus.UNLINKED,
              linkVerifiedAt: null,
              linkNotificationCompletedAt: null,
            },
      });
      return verifiedUser ? { userId: verifiedUser.id, linkedAt: linkedAt.toISOString() } : null;
    });
  }

  async getPendingLinkNotificationEmail(
    input: ProcessWhatsAppAccountLinkNotificationJobData,
  ): Promise<string | null> {
    const conversation = await this.databaseService.whatsAppConversation.findFirst({
      where: {
        id: input.conversationId,
        linkedUserId: input.userId,
        linkStatus: WhatsAppLinkStatus.LINKED,
        linkVerifiedAt: new Date(input.linkedAt),
        linkNotificationCompletedAt: null,
      },
      select: { linkedUser: { select: { email: true } } },
    });
    return conversation?.linkedUser?.email ?? null;
  }

  async markLinkNotificationCompleted(
    input: ProcessWhatsAppAccountLinkNotificationJobData,
  ): Promise<void> {
    await this.databaseService.whatsAppConversation.updateMany({
      where: {
        id: input.conversationId,
        linkedUserId: input.userId,
        linkStatus: WhatsAppLinkStatus.LINKED,
        linkVerifiedAt: new Date(input.linkedAt),
        linkNotificationCompletedAt: null,
      },
      data: { linkNotificationCompletedAt: new Date() },
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
        updatedAt: now,
        conversation: {
          connect: { id: conversationId },
        },
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
    const now = new Date();
    return this.databaseService.whatsAppOutbox.upsert({
      where: { dedupeKey: input.dedupeKey },
      update: {},
      create: {
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
        updatedAt: now,
      },
      select: { id: true },
    });
  }

  async claimOutboxForProcessing(outboxId: string, now: Date): Promise<boolean> {
    const staleProcessingBefore = new Date(now.getTime() - WHATSAPP_OUTBOX_PROCESSING_TTL_MS);
    const claimResult = await this.databaseService.whatsAppOutbox.updateMany({
      where: {
        id: outboxId,
        providerMessageSid: null,
        OR: [
          { status: WhatsAppOutboxStatus.PENDING },
          { status: WhatsAppOutboxStatus.FAILED, nextAttemptAt: { lte: now } },
          {
            status: WhatsAppOutboxStatus.PROCESSING,
            lastAttemptAt: { lte: staleProcessingBefore },
          },
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
          updatedAt: sentAt,
          conversation: {
            connect: { id: conversationId },
          },
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

  async getInboundMessageContext(messageId: string): Promise<InboundMessageContextRecord | null> {
    const message = await this.databaseService.whatsAppMessage.findUnique({
      where: { id: messageId },
      select: INBOUND_MESSAGE_CONTEXT_SELECT,
    });

    if (!message) {
      return null;
    }

    if (message.direction !== "INBOUND") {
      this.logger.warn({ messageId }, "Non-inbound message was passed to inbound processor");
      return null;
    }

    if (message.status === "PROCESSED") {
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

  async clearConversationHandoff(conversationId: string): Promise<void> {
    await this.databaseService.whatsAppConversation.update({
      where: { id: conversationId },
      data: {
        status: "ACTIVE",
        handoffReason: null,
        handoffAt: null,
      },
    });
  }

  async getConversationActivity(
    conversationId: string,
  ): Promise<{ lastInboundAt: Date | null } | null> {
    return this.databaseService.whatsAppConversation.findUnique({
      where: { id: conversationId },
      select: { lastInboundAt: true },
    });
  }

  async getConversationLinkState(
    conversationId: string,
  ): Promise<{ linkedUserId: string | null; linkStatus: WhatsAppLinkStatus | null }> {
    const conversation = await this.databaseService.whatsAppConversation.findUnique({
      where: { id: conversationId },
      select: {
        linkedUserId: true,
        linkStatus: true,
      },
    });

    return {
      linkedUserId: conversation?.linkedUserId ?? null,
      linkStatus: conversation?.linkStatus ?? null,
    };
  }

  isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
}
