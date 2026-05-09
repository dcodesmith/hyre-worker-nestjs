import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PinoLogger } from "nestjs-pino";
import { NotificationOutboxService } from "./notification-outbox.service";

@Injectable()
export class NotificationOutboxScheduler {
  /**
   * Cap on consecutive immediate re-ticks within a single cron firing. Bounds
   * worst-case time spent inside one cron handler so a sustained burst can't
   * starve other cron jobs sharing the scheduler thread (Issue 16A).
   *
   * At default limit = 25 events/tick × 5 ticks = up to 125 events drained
   * per cron firing before yielding to the next 5-second cycle.
   */
  private readonly maxConsecutiveTicks = 5;

  /**
   * In-flight guard: if a previous cron firing is still draining, the next
   * firing skips immediately rather than overlapping. Prevents two scheduler
   * loops from racing on the same candidate set under heavy load.
   */
  private isProcessing = false;

  constructor(
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationOutboxScheduler.name);
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async processNotificationOutbox() {
    if (this.isProcessing) {
      return;
    }
    this.isProcessing = true;
    try {
      let totalProcessed = 0;
      for (let tick = 0; tick < this.maxConsecutiveTicks; tick++) {
        const processedCount = await this.notificationOutboxService.processPendingEvents();
        totalProcessed += processedCount;
        // Empty tick means the queue drained — stop and yield until next cron.
        if (processedCount === 0) {
          break;
        }
      }
      if (totalProcessed > 0) {
        this.logger.info(
          { processedCount: totalProcessed },
          "Processed pending notification outbox events",
        );
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to process notification outbox events",
      );
    } finally {
      this.isProcessing = false;
    }
  }
}
