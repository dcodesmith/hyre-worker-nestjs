import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { NOTIFICATIONS_QUEUE } from "src/config/constants";
import { AuthModule } from "../auth/auth.module";
import { EmailModule } from "../email/email.module";
import { NotificationProcessor } from "./notification.processor";
import { NotificationService } from "./notification.service";
import { NotificationOutboxScheduler } from "./notification-outbox.scheduler";
import { NotificationOutboxService } from "./notification-outbox.service";
import { PushService } from "./push.service";
import { PushTokenController } from "./push-token.controller";
import { PushTokenService } from "./push-token.service";
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
    AuthModule,
    EmailModule,
  ],
  controllers: [PushTokenController],
  providers: [
    NotificationService,
    NotificationProcessor,
    NotificationOutboxService,
    NotificationOutboxScheduler,
    WhatsAppService,
    PushService,
    PushTokenService,
  ],
  exports: [
    NotificationService,
    NotificationOutboxService,
    WhatsAppService,
    PushTokenService,
    BullModule,
  ],
})
export class NotificationModule {}
