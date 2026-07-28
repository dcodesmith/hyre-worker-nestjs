import { Injectable } from "@nestjs/common";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import type { ExtensionWithNotificationRelations } from "../../../types";
import { NotificationService } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

const CUSTOMER_SUBTYPE = "BOOKING_EXTENSION_CONFIRMED_CUSTOMER";

export type BookingExtensionConfirmedInput = {
  extension: ExtensionWithNotificationRelations;
};

@Injectable()
export class BookingExtensionConfirmedHandler
  implements OutboxEventHandler<BookingExtensionConfirmedInput>
{
  readonly eventType = NotificationOutboxEventType.BOOKING_LIFECYCLE;

  constructor(private readonly notificationService: NotificationService) {}

  async buildEvents({ extension }: BookingExtensionConfirmedInput): Promise<HandlerEvent[]> {
    const jobData = await this.notificationService.buildBookingExtensionConfirmedJobData(extension);
    const booking = extension.bookingLeg.booking;
    const event: HandlerEvent = {
      jobData: jobData ?? undefined,
      dedupeKey: `booking-extension-confirmed:${extension.id}:client`,
      userId: booking.userId ?? null,
      subtype: CUSTOMER_SUBTYPE,
    };

    if (booking.userId) {
      event.inbox = {
        userId: booking.userId,
        type: NotificationInboxType.BOOKING_LIFECYCLE,
        title: "Booking extension confirmed",
        body: "Your booking extension has been confirmed.",
        payload: {
          bookingId: booking.id,
          extensionId: extension.id,
          status: "ACTIVE",
        },
      };
    }

    return event.inbox || event.jobData ? [event] : [];
  }
}
