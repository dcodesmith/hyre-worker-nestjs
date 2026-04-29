import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import type { TwilioWebhookPayload } from "./messaging.interface";

@Injectable()
export class MessagingService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(MessagingService.name);
  }

  async handleTwilioStatusCallback(payload: TwilioWebhookPayload): Promise<void> {
    this.logger.info(
      {
        messageSid: payload.MessageSid ?? null,
        messageStatus: payload.MessageStatus ?? null,
        hasErrorCode: Boolean(payload.ErrorCode),
      },
      "Processed Twilio status callback",
    );
  }
}
