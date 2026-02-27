import { Module } from "@nestjs/common";
import { WhatsAppWebhookTestCommand } from "./whatsapp-webhook-test";

@Module({
  providers: [WhatsAppWebhookTestCommand],
})
export class CommandsModule {}
