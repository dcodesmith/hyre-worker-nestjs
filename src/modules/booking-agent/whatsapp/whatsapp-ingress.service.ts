import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
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
  constructor(
    private readonly persistenceService: WhatsAppPersistenceService,
    private readonly windowPolicyService: BookingAgentWindowPolicyService,
    private readonly logger: PinoLogger,
    @InjectQueue(WHATSAPP_AGENT_QUEUE)
    private readonly whatsappAgentQueue: Queue<ProcessWhatsAppInboundJobData>,
  ) {
    this.logger.setContext(WhatsAppIngressService.name);
  }

  async handleInbound(payload: TwilioInboundWebhookPayload): Promise<void> {
    if (!isInboundCustomerMessage(payload)) {
      this.logger.debug("Skipping non-customer webhook payload");
      return;
    }

    const phoneE164 = normalizeTwilioWhatsAppPhone(payload.From);
    if (!phoneE164) {
      this.logger.warn(
        {
          from: payload.From,
          sid: payload.MessageSid,
        },
        "Skipping payload with invalid WhatsApp phone",
      );
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
        this.logger.debug({ dedupeKey, phoneE164 }, "Duplicate inbound webhook ignored");
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
        this.logger.error(
          {
            messageId,
            dedupeKey,
            cleanupError:
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          },
          "Failed to cleanup inbound message after enqueue failure",
        );
      }
      throw error;
    }

    try {
      await this.persistenceService.markInboundMessageQueued(messageId);
    } catch (error) {
      this.logger.error(
        {
          messageId,
          dedupeKey,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to mark inbound message as queued after successful enqueue",
      );
    }
  }
}
