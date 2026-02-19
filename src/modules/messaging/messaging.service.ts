import { Injectable, Logger } from "@nestjs/common";
import type { TwilioWebhookPayload } from "./messaging.interface";

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  async handleTwilioStatusCallback(payload: TwilioWebhookPayload): Promise<void> {
    this.logger.log("Processed Twilio status callback", {
      messageSid: payload.MessageSid ?? null,
      messageStatus: payload.MessageStatus ?? null,
      hasErrorCode: Boolean(payload.ErrorCode),
    });
  }
}
