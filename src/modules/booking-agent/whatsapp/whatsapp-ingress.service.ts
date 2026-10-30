import { Buffer } from "node:buffer";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { toLogError } from "../../../common/logging/error-logging.helper";
import { PROCESS_WHATSAPP_INBOUND_JOB, WHATSAPP_AGENT_QUEUE } from "../../../config/constants";
import type { EnvConfig } from "../../../config/env.config";
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
  private static readonly TYPING_INDICATOR_URL =
    "https://messaging.twilio.com/v3/Indicators/Typing.json";
  private static readonly TYPING_INDICATOR_TIMEOUT_MS = 2_000;

  constructor(
    private readonly persistenceService: WhatsAppPersistenceService,
    private readonly windowPolicyService: BookingAgentWindowPolicyService,
    private readonly configService: ConfigService<EnvConfig>,
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
      this.logger.warn({ sid: payload.MessageSid }, "Skipping payload with invalid WhatsApp phone");
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
        this.logger.debug({ dedupeKey }, "Duplicate inbound webhook ignored");
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
            err: toLogError(cleanupError),
          },
          "Failed to cleanup inbound message after enqueue failure",
        );
      }
      throw error;
    }

    void this.sendTypingIndicator(payload.MessageSid);

    try {
      await this.persistenceService.markInboundMessageQueued(messageId);
    } catch (error) {
      this.logger.error(
        {
          messageId,
          dedupeKey,
          err: toLogError(error),
        },
        "Failed to mark inbound message as queued after successful enqueue",
      );
    }
  }

  private async sendTypingIndicator(messageSid?: string): Promise<void> {
    const apiKeySid = this.configService.get("TWILIO_API_KEY_SID", { infer: true });
    const apiKeySecret = this.configService.get("TWILIO_API_KEY_SECRET", { infer: true });
    if (!messageSid || !apiKeySid || !apiKeySecret) {
      return;
    }

    try {
      const basicAuth = Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString("base64");
      const response = await fetch(WhatsAppIngressService.TYPING_INDICATOR_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: "WHATSAPP",
          messageId: messageSid,
        }),
        signal: AbortSignal.timeout(WhatsAppIngressService.TYPING_INDICATOR_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.warn(
          { messageSid, status: response.status },
          "Twilio WhatsApp typing indicator request failed",
        );
      }
    } catch (error) {
      this.logger.warn(
        { messageSid, err: toLogError(error) },
        "Twilio WhatsApp typing indicator request failed",
      );
    }
  }
}
