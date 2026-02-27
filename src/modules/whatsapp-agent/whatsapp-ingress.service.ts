import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Prisma, WhatsAppMessageKind } from "@prisma/client";
import { Queue } from "bullmq";
import { PROCESS_WHATSAPP_INBOUND_JOB, WHATSAPP_AGENT_QUEUE } from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import { WHATSAPP_QUEUE_DEFAULT_JOB_OPTIONS } from "./whatsapp-agent.const";
import { WhatsAppInboundMessageIdMissingException } from "./whatsapp-agent.error";
import type {
  ProcessWhatsAppInboundJobData,
  TwilioInboundWebhookPayload,
} from "./whatsapp-agent.interface";
import {
  buildInboundDedupeKey,
  deriveMessageKind,
  extractInboundMedia,
  isInboundCustomerMessage,
  normalizeTwilioWhatsAppPhone,
} from "./whatsapp-agent.utils";
import { WhatsAppConversationService } from "./whatsapp-conversation.service";
import { WhatsAppWindowPolicyService } from "./whatsapp-window-policy.service";

@Injectable()
export class WhatsAppIngressService {
  private readonly logger = new Logger(WhatsAppIngressService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly conversationService: WhatsAppConversationService,
    private readonly windowPolicyService: WhatsAppWindowPolicyService,
    @InjectQueue(WHATSAPP_AGENT_QUEUE)
    private readonly whatsappAgentQueue: Queue<ProcessWhatsAppInboundJobData>,
  ) {}

  async handleInbound(payload: TwilioInboundWebhookPayload): Promise<void> {
    if (!isInboundCustomerMessage(payload)) {
      this.logger.debug("Skipping non-customer webhook payload");
      return;
    }

    const phoneE164 = normalizeTwilioWhatsAppPhone(payload.From);
    if (!phoneE164) {
      this.logger.warn("Skipping payload with invalid WhatsApp phone", {
        from: payload.From,
        sid: payload.MessageSid,
      });
      return;
    }

    const dedupeKey = buildInboundDedupeKey(payload);
    const now = new Date();
    const windowExpiresAt = this.windowPolicyService.computeWindowExpiry(now);
    const media = extractInboundMedia(payload);
    const messageKind = deriveMessageKind(payload) as WhatsAppMessageKind;

    const conversation = await this.databaseService.whatsAppConversation.upsert({
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

    let messageId: string | null = null;

    try {
      const message = await this.databaseService.whatsAppMessage.create({
        data: {
          conversationId: conversation.id,
          providerMessageSid: payload.MessageSid ?? null,
          dedupeKey,
          direction: "INBOUND",
          kind: messageKind,
          status: "RECEIVED",
          body: payload.Body ?? null,
          mediaUrl: media[0]?.url ?? null,
          mediaContentType: media[0]?.contentType ?? null,
          rawPayload: payload as unknown as Prisma.InputJsonValue,
          receivedAt: now,
        },
        select: { id: true },
      });
      messageId = message.id;
    } catch (error) {
      if (this.conversationService.isUniqueViolation(error)) {
        this.logger.debug("Duplicate inbound webhook ignored", { dedupeKey, phoneE164 });
        return;
      }
      throw error;
    }

    if (!messageId) {
      throw new WhatsAppInboundMessageIdMissingException();
    }

    try {
      await this.whatsappAgentQueue.add(
        PROCESS_WHATSAPP_INBOUND_JOB,
        {
          conversationId: conversation.id,
          messageId,
          dedupeKey,
        },
        {
          ...WHATSAPP_QUEUE_DEFAULT_JOB_OPTIONS,
          jobId: dedupeKey,
        },
      );
    } catch (error) {
      try {
        await this.databaseService.whatsAppMessage.delete({ where: { id: messageId } });
      } catch (cleanupError) {
        this.logger.error("Failed to cleanup inbound message after enqueue failure", {
          messageId,
          dedupeKey,
          cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    }

    await this.conversationService.markInboundMessageQueued(messageId);
  }
}
