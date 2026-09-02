import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PinoLogger } from "nestjs-pino";
import { toLogError } from "../../common/logging/error-logging.helper";
import { DomainOutboxService } from "./domain-outbox.service";

@Injectable()
export class DomainOutboxScheduler {
  private isProcessing = false;

  constructor(
    private readonly domainOutboxService: DomainOutboxService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DomainOutboxScheduler.name);
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async processDomainOutbox(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    try {
      const processedCount = await this.domainOutboxService.processPendingEvents();
      if (processedCount > 0) {
        this.logger.info({ processedCount }, "Processed pending domain outbox events");
      }
    } catch (error) {
      this.logger.error({ err: toLogError(error) }, "Failed to process domain outbox events");
    } finally {
      this.isProcessing = false;
    }
  }
}
