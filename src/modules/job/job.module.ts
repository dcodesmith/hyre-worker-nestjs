import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { REMINDERS_QUEUE, STATUS_UPDATES_QUEUE } from "../../config/constants";
import { JobController } from "./job.controller";
import { JobService } from "./job.service";
import { JobThrottlerGuard } from "./job-throttler.guard";

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: "manual-triggers",
        ttl: 3600,
        limit: 1,
      },
    ]),
    BullModule.registerQueue({ name: REMINDERS_QUEUE }, { name: STATUS_UPDATES_QUEUE }),
  ],
  controllers: [JobController],
  providers: [JobService, JobThrottlerGuard],
})
export class JobModule {}
