import { Injectable } from "@nestjs/common";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import type { BookingWithRelations } from "../../../types";
import { NotificationService } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

const SUBTYPE = "BOOKING_STATUS_CHANGED";

export type BookingStatusChangedInput = {
  booking: BookingWithRelations;
  oldStatus: string;
  newStatus: string;
  showReviewRequest?: boolean;
};

@Injectable()
export class BookingStatusChangedHandler implements OutboxEventHandler<BookingStatusChangedInput> {
  readonly eventType = NotificationOutboxEventType.BOOKING_LIFECYCLE;

  constructor(private readonly notificationService: NotificationService) {}

  async buildEvents({
    booking,
    oldStatus,
    newStatus,
    showReviewRequest = false,
  }: BookingStatusChangedInput): Promise<HandlerEvent[]> {
    const jobData = await this.notificationService.buildBookingStatusChangeJobData({
      booking,
      oldStatus,
      newStatus,
      showReviewRequest,
    });

    const event: HandlerEvent = {
      jobData: jobData ?? undefined,
      dedupeKey: `booking-status:${booking.id}:${oldStatus}:${newStatus}:${booking.updatedAt.toISOString()}`,
      userId: booking.userId ?? null,
      subtype: SUBTYPE,
    };

    // Inbox is in-app state and must reflect the change regardless of whether
    // any external delivery channels are configured (Issue 5A).
    if (booking.userId) {
      event.inbox = {
        userId: booking.userId,
        type: NotificationInboxType.BOOKING_LIFECYCLE,
        title: "Booking status updated",
        body: `Your booking has moved from ${oldStatus.toLowerCase()} to ${newStatus.toLowerCase()}.`,
        payload: { bookingId: booking.id, oldStatus, newStatus },
      };
    }

    if (!event.inbox && !event.jobData) {
      return [];
    }

    return [event];
  }
}
