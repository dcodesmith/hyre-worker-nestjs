import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { ReminderModule } from "../reminder/reminder.module";
import { StatusChangeModule } from "../status-change/status-change.module";
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
    ReminderModule,
    StatusChangeModule,
  ],
  controllers: [JobController],
  providers: [JobService, JobThrottlerGuard],
})
export class JobModule {}
