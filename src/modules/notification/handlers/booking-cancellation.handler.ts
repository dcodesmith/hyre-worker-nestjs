import { Injectable } from "@nestjs/common";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import type { BookingWithRelations } from "../../../types";
import { NotificationService } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

const CUSTOMER_SUBTYPE = "BOOKING_CANCELLED_CUSTOMER";
const OWNER_SUBTYPE = "BOOKING_CANCELLED_OWNER";

export type BookingCancellationInput = {
  booking: BookingWithRelations;
};

@Injectable()
export class BookingCancellationHandler implements OutboxEventHandler<BookingCancellationInput> {
  /**
   * Cancellation is a domain-state change with downstream notifications, so
   * it lives under BOOKING_LIFECYCLE alongside other status transitions. The
   * subtype distinguishes customer-vs-owner fan-out for observability.
   */
  readonly eventType = NotificationOutboxEventType.BOOKING_LIFECYCLE;

  constructor(private readonly notificationService: NotificationService) {}

  async buildEvents({ booking }: BookingCancellationInput): Promise<HandlerEvent[]> {
    const { customer, owner } = this.notificationService.buildBookingCancellationJobData(booking);
    // Cancellation timestamp is the canonical dedupe anchor — it's set in the
    // same tx that flips the booking, so it changes only with new cancellations.
    const cancelAnchor = booking.cancelledAt?.toISOString() ?? booking.updatedAt.toISOString();

    const events: HandlerEvent[] = [];

    const customerEvent: HandlerEvent = {
      jobData: customer ?? undefined,
      dedupeKey: `booking-cancelled:${booking.id}:client:${cancelAnchor}`,
      userId: booking.userId ?? null,
      subtype: CUSTOMER_SUBTYPE,
    };
    if (booking.userId) {
      customerEvent.inbox = {
        userId: booking.userId,
        type: NotificationInboxType.BOOKING_LIFECYCLE,
        title: "Booking cancelled",
        body: "Your booking has been cancelled. A refund is being processed.",
        payload: { bookingId: booking.id, status: "CANCELLED" },
      };
    }
    if (customerEvent.inbox || customerEvent.jobData) {
      events.push(customerEvent);
    }

    if (owner) {
      events.push({
        jobData: owner,
        dedupeKey: `booking-cancelled:${booking.id}:fleet-owner:${cancelAnchor}`,
        // Fleet owner inbox isn't wired in this app yet; only push outbox.
        userId: null,
        subtype: OWNER_SUBTYPE,
      });
    }

    return events;
  }
}
