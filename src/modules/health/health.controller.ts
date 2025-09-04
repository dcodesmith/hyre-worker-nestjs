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
import { randomUUID } from "node:crypto";
import { Throttle } from "@nestjs/throttler";

@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly manualTriggersEnabled: boolean;

  constructor(
    private readonly healthService: HealthService,
    @InjectQueue("reminder-emails") private readonly reminderQueue: Queue,
    @InjectQueue("status-updates") private readonly statusUpdateQueue: Queue,
    // private readonly configService: ConfigService,
  ) {
    this.manualTriggersEnabled = true;
  }

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

  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60 } })
  @Post("trigger/reminders")
  async triggerReminders() {
    if (!this.manualTriggersEnabled) {
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    }

    try {
      await this.enqueue(this.reminderQueue, "booking-leg-start-reminder", "trip-start");

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
      await this.enqueue(this.statusUpdateQueue, "confirmed-to-active", "confirmed-to-active");

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
  async triggerEndReminders() {
    if (!this.manualTriggersEnabled) {
      throw new ForbiddenException("Manual trigger endpoints are disabled");
    }

    try {
      await this.enqueue(this.reminderQueue, "booking-leg-end-reminder", "trip-end");

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
      await this.enqueue(this.statusUpdateQueue, "active-to-completed", "active-to-completed");
      return { success: true, message: "Complete bookings job triggered" };
    } catch (error) {
      throw new HttpException(
        { error: error instanceof Error ? error.message : "Unknown error" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async enqueue(queue: Queue, name: string, type: string) {
    const timestamp = new Date().toISOString();
    const jobId = `${name}:${timestamp}:${randomUUID().slice(0, 8)}`;

    await queue.add(
      name,
      { type, timestamp },
      {
        jobId,
        removeOnComplete: true,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      },
    );
    this.logger.log(`Enqueued ${name} jobId=${jobId}`);
  }
}
