import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PinoLogger } from "nestjs-pino";
import { NotificationOutboxService } from "./notification-outbox.service";

@Injectable()
export class NotificationOutboxScheduler {
  constructor(
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationOutboxScheduler.name);
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async processNotificationOutbox() {
    try {
      const processedCount = await this.notificationOutboxService.processPendingEvents();
      if (processedCount > 0) {
        this.logger.info({ processedCount }, "Processed pending notification outbox events");
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to process notification outbox events",
      );
    }
  }
}
