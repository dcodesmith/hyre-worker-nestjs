import {
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JobService } from "./job.service";

@Controller("job")
export class JobController {
  private readonly manualTriggersEnabled: boolean;

  constructor(private readonly jobService: JobService) {
    this.manualTriggersEnabled = true;
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60 } })
  @Post("trigger/reminders")
  async triggerReminders() {
    if (!this.manualTriggersEnabled) {
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    }

    try {
      await this.jobService.triggerStartBookingLegReminders();
      return { success: true, message: "Reminder job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60 } })
  @Post("trigger/status-updates")
  async triggerStatusUpdates() {
    if (!this.manualTriggersEnabled) {
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    }

    try {
      await this.jobService.triggerStatusUpdates();
      return { success: true, message: "Status update job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60 } })
  @Post("trigger/end-reminders")
  async triggerBookingLegEndReminders() {
    if (!this.manualTriggersEnabled) {
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    }

    try {
      await this.jobService.triggerBookingLegEndReminders();
      return { success: true, message: "End reminder job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60 } })
  @Post("trigger/complete-bookings")
  async triggerCompleteBookings() {
    if (!this.manualTriggersEnabled) {
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    }

    try {
      await this.jobService.triggerCompleteBookings();
      return { success: true, message: "Complete bookings job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
