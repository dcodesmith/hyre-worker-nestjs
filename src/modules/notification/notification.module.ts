import { BullModule } from "@nestjs/bull";
import { Module } from "@nestjs/common";
import { EmailService } from "./email.service";
import { NotificationProcessor } from "./notification.processor";
import { NotificationService } from "./notification.service";
import { WhatsAppService } from "./whatsapp.service";

@Module({
  imports: [
    BullModule.registerQueue({
      name: "notifications",
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
        removeOnComplete: 100, // Keep last 100 successful jobs
        removeOnFail: 50, // Keep last 50 failed jobs
      },
      settings: {
        stalledInterval: 30000,
        maxStalledCount: 1,
      },
    }),
  ],
  providers: [NotificationService, NotificationProcessor, EmailService, WhatsAppService],
  exports: [NotificationService, EmailService, WhatsAppService],
})
export class NotificationModule {}
