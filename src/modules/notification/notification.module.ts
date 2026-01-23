import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { NOTIFICATIONS_QUEUE } from "src/config/constants";
import { EmailService } from "./email.service";
import { NotificationProcessor } from "./notification.processor";
import { NotificationService } from "./notification.service";
import { WhatsAppService } from "./whatsapp.service";

@Module({
  imports: [
    BullModule.registerQueue({
      name: NOTIFICATIONS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
        removeOnComplete: 100, // Keep last 100 successful jobs
        removeOnFail: 50, // Keep last 50 failed jobs
      },
    }),
    BullBoardModule.forFeature({
      name: NOTIFICATIONS_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [NotificationService, NotificationProcessor, EmailService, WhatsAppService],
  exports: [NotificationService, EmailService, WhatsAppService, BullModule],
})
export class NotificationModule {}
