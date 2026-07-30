import { Injectable } from "@nestjs/common";
import { NotificationOutboxEventType } from "@prisma/client";
import type { PayoutStatusChangedNotificationParams } from "../notification.interface";
import { NotificationService } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

@Injectable()
export class PayoutStatusChangedHandler
  implements OutboxEventHandler<PayoutStatusChangedNotificationParams>
{
  readonly eventType = NotificationOutboxEventType.BOOKING_LIFECYCLE;

  constructor(private readonly notificationService: NotificationService) {}

  async buildEvents(input: PayoutStatusChangedNotificationParams): Promise<HandlerEvent[]> {
    const jobData = this.notificationService.buildPayoutStatusChangedJobData(input);
    if (!jobData) {
      return [];
    }

    return [
      {
        jobData,
        dedupeKey: `payout-status:${input.payoutTransactionId}:${input.status}`,
        userId: null,
        subtype: `PAYOUT_${input.status}`,
      },
    ];
  }
}
