import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import { WHATSAPP_PROCESSING_LOCK_TTL_MS } from "./whatsapp-agent.const";

@Injectable()
export class WhatsAppConversationService {
  private readonly logger = new Logger(WhatsAppConversationService.name);

  constructor(private readonly databaseService: DatabaseService) {}

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
        status: true,
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
