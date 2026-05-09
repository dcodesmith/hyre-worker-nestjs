import { Injectable } from "@nestjs/common";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import type { BookingWithRelations } from "../../../types";
import { NotificationService } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

const SUBTYPE = "CHAUFFEUR_ASSIGNED";

export type ChauffeurAssignedInput = {
  booking: BookingWithRelations;
  chauffeurId: string;
};

@Injectable()
export class ChauffeurAssignedHandler implements OutboxEventHandler<ChauffeurAssignedInput> {
  readonly eventType = NotificationOutboxEventType.BOOKING_ASSIGNMENT;

  constructor(private readonly notificationService: NotificationService) {}

  async buildEvents({ booking, chauffeurId }: ChauffeurAssignedInput): Promise<HandlerEvent[]> {
    const jobData = await this.notificationService.buildChauffeurAssignedJobData(booking);
    const dedupeKey = `chauffeur-assigned:${booking.id}:${chauffeurId}:${booking.updatedAt.toISOString()}`;

    const event: HandlerEvent = {
      jobData: jobData ?? undefined,
      dedupeKey,
      userId: booking.userId ?? null,
      subtype: SUBTYPE,
    };

    if (booking.userId) {
      event.inbox = {
        userId: booking.userId,
        type: NotificationInboxType.BOOKING_ASSIGNMENT,
        title: "Your chauffeur has been assigned",
        body: `Your chauffeur for ${booking.car.make} ${booking.car.model} (${booking.car.year}) has been assigned.`,
        payload: { bookingId: booking.id, chauffeurId },
      };
    }

    // No inbox and no jobData → nothing to write. Skip emission.
    if (!event.inbox && !event.jobData) {
      return [];
    }
    return [event];
  }
}
