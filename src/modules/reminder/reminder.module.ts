import { BullModule } from "@nestjs/bull";
import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { NotificationModule } from "../notification/notification.module";
import { ReminderProcessor } from "./reminder.processor";
import { ReminderScheduler } from "./reminder.scheduler";
import { ReminderService } from "./reminder.service";

@Module({
  imports: [
    DatabaseModule,
    NotificationModule,
    BullModule.registerQueue({ name: "reminder-emails" }),
  ],
  providers: [ReminderService, ReminderProcessor, ReminderScheduler],
  exports: [ReminderService],
})
export class ReminderModule {}
