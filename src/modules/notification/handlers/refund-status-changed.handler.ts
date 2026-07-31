import { Injectable } from "@nestjs/common";
import { NotificationOutboxEventType } from "@prisma/client";
import type { RefundStatusChangedNotificationParams } from "../notification.interface";
import { NotificationService } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

@Injectable()
export class RefundStatusChangedHandler
  implements OutboxEventHandler<RefundStatusChangedNotificationParams>
{
  readonly eventType = NotificationOutboxEventType.BOOKING_LIFECYCLE;

  constructor(private readonly notificationService: NotificationService) {}

  async buildEvents(input: RefundStatusChangedNotificationParams): Promise<HandlerEvent[]> {
    const jobData = this.notificationService.buildRefundStatusChangedJobData(input);
    if (!jobData) {
      return [];
    }

    return [
      {
        jobData,
        dedupeKey: `refund-status:${input.refundId}:${input.status}`,
        userId: null,
        subtype: `REFUND_${input.status}`,
      },
    ];
  }
}
