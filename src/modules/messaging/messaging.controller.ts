import { Body, Controller, Header, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { TwilioWebhookGuard } from "./guards/twilio-webhook.guard";
import type { TwilioWebhookPayload } from "./messaging.interface";
import { MessagingService } from "./messaging.service";

@Controller("api/messaging")
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  @Post("webhook/twilio")
  @HttpCode(HttpStatus.OK)
  @Header("Content-Type", "application/xml")
  @UseGuards(TwilioWebhookGuard)
  async handleTwilioWebhook(@Body() payload: TwilioWebhookPayload): Promise<string> {
    await this.messagingService.handleTwilioStatusCallback(payload);
    return "<Response></Response>";
  }
}
