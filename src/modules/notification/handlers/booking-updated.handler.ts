import { Injectable } from "@nestjs/common";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import type { BookingWithRelations } from "../../../types";
import { NotificationService } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

const SUBTYPE = "BOOKING_UPDATED";

export type BookingUpdateActor = { type: "user"; userId: string } | { type: "system" };

export type BookingUpdatedInput = {
  booking: BookingWithRelations;
  actor: BookingUpdateActor;
};

export function shouldPushBookingUpdate(
  actor: BookingUpdateActor,
  customerUserId: string | null,
): boolean {
  return actor.type === "system" || actor.userId !== customerUserId;
}

@Injectable()
export class BookingUpdatedHandler implements OutboxEventHandler<BookingUpdatedInput> {
  readonly eventType = NotificationOutboxEventType.BOOKING_LIFECYCLE;

  constructor(private readonly notificationService: NotificationService) {}

  async buildEvents({ booking, actor }: BookingUpdatedInput): Promise<HandlerEvent[]> {
    const jobData = await this.notificationService.buildBookingUpdatedJobData(
      booking,
      shouldPushBookingUpdate(actor, booking.userId),
    );
    const event: HandlerEvent = {
      jobData: jobData ?? undefined,
      dedupeKey: `booking-updated:${booking.id}:${booking.updatedAt.toISOString()}`,
      userId: booking.userId ?? null,
      subtype: SUBTYPE,
    };

    if (booking.userId) {
      event.inbox = {
        userId: booking.userId,
        type: NotificationInboxType.BOOKING_LIFECYCLE,
        title: "Booking updated",
        body: "Your booking details have been updated.",
        payload: { bookingId: booking.id },
      };
    }

    return event.inbox || event.jobData ? [event] : [];
  }
}
