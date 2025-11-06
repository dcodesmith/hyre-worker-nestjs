import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Module } from "@nestjs/common";
import { REMINDERS_QUEUE } from "../../config/constants";
import { DatabaseModule } from "../database/database.module";
import { NotificationModule } from "../notification/notification.module";
import { ReminderProcessor } from "./reminder.processor";
import { ReminderScheduler } from "./reminder.scheduler";
import { ReminderService } from "./reminder.service";

@Module({
  imports: [
    DatabaseModule,
    NotificationModule,
    BullModule.registerQueue({ name: REMINDERS_QUEUE }),
    BullBoardModule.forFeature({
      name: REMINDERS_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [ReminderService, ReminderProcessor, ReminderScheduler],
  exports: [ReminderService, BullModule],
})
export class ReminderModule {}
