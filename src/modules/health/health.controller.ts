import { InjectQueue } from "@nestjs/bull";
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
} from "@nestjs/common";
import { Queue } from "bull";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  private readonly manualTriggersEnabled: boolean;
  constructor(
    private readonly healthService: HealthService,
    @InjectQueue("reminder-emails") private readonly reminderQueue: Queue,
    @InjectQueue("status-updates") private readonly statusUpdateQueue: Queue,
    // private readonly configService: ConfigService,
  ) {
    this.manualTriggersEnabled = true;
  }

  private readonly logger = new Logger(HealthController.name);

  @Get()
  async health() {
    try {
      return await this.healthService.checkHealth();
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Get("queue-stats")
  async queueStats() {
    try {
      return await this.healthService.getQueueStats();
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post("trigger/reminders")
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerReminders() {
    if (!this.manualTriggersEnabled) {
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    }

    const timestamp = new Date().toISOString();

    try {
      await this.reminderQueue.add(
        "booking-leg-start-reminder",
        {
          type: "trip-start",
          timestamp,
        },
        { jobId: `booking-leg-start-reminder:${timestamp.slice(0, 16)}`, removeOnComplete: true },
      );
      this.logger.log("Enqueued: booking-leg-start-reminder");
      return { success: true, message: "Reminder job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post("trigger/status-updates")
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerStatusUpdates() {
    if (!this.manualTriggersEnabled) {
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    }

    const timestamp = new Date().toISOString();
    try {
      await this.statusUpdateQueue.add(
        "confirmed-to-active",
        {
          type: "confirmed-to-active",
          timestamp,
        },
        { jobId: `confirmed-to-active:${timestamp.slice(0, 16)}`, removeOnComplete: true },
      );
      this.logger.log("Enqueued: confirmed-to-active");
      return { success: true, message: "Status update job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post("trigger/end-reminders")
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerEndReminders() {
    if (!this.manualTriggersEnabled) {
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    }
    const timestamp = new Date().toISOString();
    try {
      await this.reminderQueue.add(
        "booking-leg-end-reminder",
        {
          type: "trip-end",
          timestamp,
        },
        { jobId: `booking-leg-end-reminder:${timestamp.slice(0, 16)}`, removeOnComplete: true },
      );
      this.logger.log("Enqueued: booking-leg-end-reminder");
      return { success: true, message: "End reminder job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Post("trigger/complete-bookings")
  async triggerCompleteBookings() {
    if (!this.manualTriggersEnabled)
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    const timestamp = new Date().toISOString();
    try {
      await this.statusUpdateQueue.add(
        "active-to-completed",
        {
          type: "active-to-completed",
          timestamp,
        },
        { jobId: `active-to-completed:${timestamp.slice(0, 16)}`, removeOnComplete: true },
      );
      this.logger.log("Enqueued: active-to-completed");
      return { success: true, message: "Complete bookings job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
