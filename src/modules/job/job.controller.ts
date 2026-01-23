import { Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiKeyGuard } from "./api-key.guard";
import { JobException } from "./errors";
import { ValidateJobTypePipe } from "./job.dto";
import { JobThrottlerGuard } from "./job-throttler.guard";
import { JobType, JobTypeNames } from "./job.schema";
import { JobService } from "./job.service";

@Controller("job")
@UseGuards(ApiKeyGuard, JobThrottlerGuard)
export class JobController {
  private readonly manualTriggersEnabled: boolean;

  /**
   * Map of job types to their corresponding service methods
   * This ensures type safety and makes it easy to add new job types
   */
  private readonly jobHandlers: Record<JobType, () => Promise<void>>;

  constructor(
    private readonly jobService: JobService,
    private readonly configService: ConfigService,
  ) {
    this.manualTriggersEnabled = this.configService.get<boolean>("ENABLE_MANUAL_TRIGGERS") ?? false;

    // Initialize the job handlers map
    this.jobHandlers = {
      "start-reminders": () => this.jobService.triggerStartBookingLegReminders(),
      "end-reminders": () => this.jobService.triggerBookingLegEndReminders(),
      "activate-bookings": () => this.jobService.triggerActivateBookings(),
      "complete-bookings": () => this.jobService.triggerCompleteBookings(),
    };
  }

  /**
   * Unified endpoint to trigger any job type
   * @param jobType - The type of job to trigger (validated by Zod schema)
   * @returns Success response with job type and message
   */
  @HttpCode(HttpStatus.ACCEPTED)
  @Post("trigger/:jobType")
  async triggerJob(@Param("jobType", ValidateJobTypePipe) jobType: JobType) {
    if (!this.manualTriggersEnabled) {
      throw JobException.manualTriggersDisabled();
    }

    // Get the handler for this job type and execute it
    await this.jobHandlers[jobType]();

    // Return a friendly message using the job type name
    return {
      success: true,
      message: `${JobTypeNames[jobType]} job triggered`,
    };
  }
}
