import { Processor, WorkerHost } from "@nestjs/bullmq";
import { DomainOutboxEventType } from "@prisma/client";
import type { Job } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { DOMAIN_OUTBOX_QUEUE } from "../../config/constants";
import {
  PayoutBookingNotCompletedException,
  PayoutBookingNotFoundException,
} from "../payment/payment.error";
import { PaymentService } from "../payment/payment.service";
import { ReferralProcessingService } from "../referral/referral-processing.service";
import type { DomainOutboxJobData } from "./domain-outbox.interface";
import { DomainOutboxService } from "./domain-outbox.service";

@Processor(DOMAIN_OUTBOX_QUEUE)
export class DomainOutboxProcessor extends WorkerHost {
  constructor(
    private readonly domainOutboxService: DomainOutboxService,
    private readonly referralProcessingService: ReferralProcessingService,
    private readonly paymentService: PaymentService,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(DomainOutboxProcessor.name);
  }

  async process(job: Job<DomainOutboxJobData>): Promise<void> {
    const event = await this.domainOutboxService.resolveExecutableEvent(job.data);
    if (!event) {
      this.logger.warn(
        {
          outboxEventId: job.data.outboxEventId,
          eventType: job.data.eventType,
          aggregateId: job.data.aggregateId,
          dispatchAttempt: job.data.dispatchAttempt,
        },
        "Skipping domain outbox job that no longer matches a dispatched event",
      );
      return;
    }

    try {
      switch (event.eventType) {
        case DomainOutboxEventType.REFERRAL_COMPLETION:
          await this.referralProcessingService.processReferralCompletionForBooking(
            event.aggregateId,
          );
          break;
        case DomainOutboxEventType.PAYOUT_PROCESSING:
          await this.paymentService.processPayoutForBooking(event.aggregateId);
          break;
        default:
          throw new Error(`Unsupported domain outbox event type: ${event.eventType}`);
      }

      await this.domainOutboxService.markCompleted(
        job.data.outboxEventId,
        job.data.dispatchAttempt,
      );
    } catch (error) {
      if (
        error instanceof PayoutBookingNotFoundException ||
        error instanceof PayoutBookingNotCompletedException
      ) {
        await this.domainOutboxService.markFailed(
          job.data.outboxEventId,
          job.data.dispatchAttempt,
          error,
          true,
        );
        return;
      }

      if (this.isFinalAttempt(job)) {
        try {
          await this.domainOutboxService.markFailed(
            job.data.outboxEventId,
            job.data.dispatchAttempt,
            error,
          );
        } catch (markError) {
          this.logger.error(
            {
              outboxEventId: job.data.outboxEventId,
              error: markError instanceof Error ? markError.message : String(markError),
            },
            "Failed to persist terminal domain outbox job failure",
          );
        }
      }
      throw error;
    }
  }

  private isFinalAttempt(job: Job<DomainOutboxJobData>): boolean {
    return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  }
}
