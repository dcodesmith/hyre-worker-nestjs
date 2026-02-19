import { Module } from "@nestjs/common";
import { TwilioWebhookGuard } from "./guards/twilio-webhook.guard";
import { MessagingController } from "./messaging.controller";
import { MessagingService } from "./messaging.service";

@Module({
  controllers: [MessagingController],
  providers: [MessagingService, TwilioWebhookGuard],
})
export class MessagingModule {}
