// import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ReminderModule } from "../reminder/reminder.module";
import { StatusChangeModule } from "../status-change/status-change.module";
// import { REMINDERS_QUEUE, STATUS_UPDATES_QUEUE } from "../../config/constants";
import { JobController } from "./job.controller";
import { JobService } from "./job.service";

@Module({
  imports: [
    // BullModule.registerQueue({ name: REMINDERS_QUEUE }),
    // BullModule.registerQueue({ name: STATUS_UPDATES_QUEUE }),
    ReminderModule,
    StatusChangeModule,
  ],
  controllers: [JobController],
  providers: [JobService],
})
export class JobModule {}
