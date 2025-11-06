import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { REMINDERS_QUEUE, STATUS_UPDATES_QUEUE } from "../../config/constants";
import { JobController } from "./job.controller";
import { JobService } from "./job.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: REMINDERS_QUEUE }),
    BullModule.registerQueue({ name: STATUS_UPDATES_QUEUE }),
  ],
  controllers: [JobController],
  providers: [JobService],
})
export class JobModule {}
