import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { PROCESS_WHATSAPP_INBOUND_JOB, WHATSAPP_AGENT_QUEUE } from "../../../config/constants";
import { WHATSAPP_QUEUE_DEFAULT_JOB_OPTIONS } from "../booking-agent.const";
import type {
  ProcessWhatsAppInboundJobData,
  TwilioInboundWebhookPayload,
} from "../booking-agent.interface";
import { BookingAgentWindowPolicyService } from "../booking-agent-window-policy.service";
import {
  buildInboundDedupeKey,
  deriveMessageKind,
  extractInboundMedia,
  isInboundCustomerMessage,
  normalizeTwilioWhatsAppPhone,
} from "./whatsapp-agent.utils";
import { WhatsAppPersistenceService } from "./whatsapp-persistence.service";

@Injectable()
export class WhatsAppIngressService {
  private readonly logger = new Logger(WhatsAppIngressService.name);

  constructor(
    private readonly persistenceService: WhatsAppPersistenceService,
    private readonly windowPolicyService: BookingAgentWindowPolicyService,
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
    const messageKind = deriveMessageKind(payload);

    const conversation = await this.persistenceService.upsertConversationForInbound({
      phoneE164,
      payload,
      now,
      windowExpiresAt,
    });

    let messageId: string;
    try {
      const message = await this.persistenceService.createInboundMessage({
        conversationId: conversation.id,
        payload,
        dedupeKey,
        kind: messageKind,
        body: payload.Body,
        mediaUrl: media[0]?.url,
        mediaContentType: media[0]?.contentType,
        now,
      });
      messageId = message.id;
    } catch (error) {
      if (this.persistenceService.isUniqueViolation(error)) {
        this.logger.debug("Duplicate inbound webhook ignored", { dedupeKey, phoneE164 });
        return;
      }
      throw error;
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
          jobId: dedupeKey.replaceAll(":", "_"),
        },
      );
    } catch (error) {
      try {
        await this.persistenceService.deleteInboundMessage(messageId);
      } catch (cleanupError) {
        this.logger.error("Failed to cleanup inbound message after enqueue failure", {
          messageId,
          dedupeKey,
          cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    }

    try {
      await this.persistenceService.markInboundMessageQueued(messageId);
    } catch (error) {
      this.logger.error("Failed to mark inbound message as queued after successful enqueue", {
        messageId,
        dedupeKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
