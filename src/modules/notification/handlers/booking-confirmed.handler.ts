import { Injectable } from "@nestjs/common";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import type { BookingWithRelations } from "../../../types";
import { NotificationService } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

const CUSTOMER_SUBTYPE = "BOOKING_CONFIRMED_CUSTOMER";
const OWNER_SUBTYPE = "BOOKING_CONFIRMED_OWNER";

export type BookingConfirmedInput = {
  booking: BookingWithRelations;
};

@Injectable()
export class BookingConfirmedHandler implements OutboxEventHandler<BookingConfirmedInput> {
  readonly eventType = NotificationOutboxEventType.BOOKING_LIFECYCLE;

  constructor(private readonly notificationService: NotificationService) {}

  async buildEvents({ booking }: BookingConfirmedInput): Promise<HandlerEvent[]> {
    const { customer, owner } =
      await this.notificationService.buildBookingConfirmedJobData(booking);
    const confirmationAnchor = booking.updatedAt.toISOString();
    const events: HandlerEvent[] = [];

    const customerEvent: HandlerEvent = {
      jobData: customer ?? undefined,
      dedupeKey: `booking-confirmed:${booking.id}:client:${confirmationAnchor}`,
      userId: booking.userId ?? null,
      subtype: CUSTOMER_SUBTYPE,
    };

    if (booking.userId) {
      customerEvent.inbox = {
        userId: booking.userId,
        type: NotificationInboxType.BOOKING_LIFECYCLE,
        title: "Booking confirmed",
        body: customer?.pushPayload?.body ?? "Your booking has been confirmed.",
        payload: { bookingId: booking.id, status: "CONFIRMED" },
      };
    }

    if (customerEvent.inbox || customerEvent.jobData) {
      events.push(customerEvent);
    }

    if (owner) {
      events.push({
        jobData: owner,
        dedupeKey: `booking-confirmed:${booking.id}:fleet-owner:${confirmationAnchor}`,
        userId: null,
        subtype: OWNER_SUBTYPE,
      });
    }

    return events;
  }
}
