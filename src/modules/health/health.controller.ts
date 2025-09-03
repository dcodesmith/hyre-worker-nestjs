import { InjectQueue } from "@nestjs/bull";
import {
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Post,
} from "@nestjs/common";
import { Queue } from "bull";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    @InjectQueue("reminder-emails") private readonly reminderQueue: Queue,
    @InjectQueue("status-updates") private readonly statusUpdateQueue: Queue,
  ) {}

  private readonly logger = new Logger(HealthController.name);
  private readonly manualTriggersEnabled = process.env.ENABLE_MANUAL_TRIGGERS === "true";

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
  async triggerReminders() {
    if (!this.manualTriggersEnabled)
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    try {
      await this.reminderQueue.add("send-reminders", {
        type: "trip-start",
        timestamp: new Date().toISOString(),
      });
      this.logger.log("Enqueued: send-reminders");
      return { success: true, message: "Reminder job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post("trigger/status-updates")
  async triggerStatusUpdates() {
    if (!this.manualTriggersEnabled)
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    try {
      await this.statusUpdateQueue.add("update-status", {
        type: "confirmed-to-active",
        timestamp: new Date().toISOString(),
      });
      this.logger.log("Enqueued: update-status");
      return { success: true, message: "Status update job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post("trigger/end-reminders")
  async triggerEndReminders() {
    if (!this.manualTriggersEnabled)
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    try {
      await this.reminderQueue.add("send-end-reminders", {
        type: "trip-end",
        timestamp: new Date().toISOString(),
      });
      this.logger.log("Enqueued: send-end-reminders");
      return { success: true, message: "End reminder job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post("trigger/complete-bookings")
  async triggerCompleteBookings() {
    if (!this.manualTriggersEnabled)
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    try {
      await this.statusUpdateQueue.add("complete-bookings", {
        type: "active-to-completed",
        timestamp: new Date().toISOString(),
      });
      this.logger.log("Enqueued: complete-bookings");
      return { success: true, message: "Complete bookings job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
