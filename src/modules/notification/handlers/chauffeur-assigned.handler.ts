import { Injectable } from "@nestjs/common";
import {
  BookingType,
  type Flight,
  NotificationInboxType,
  NotificationOutboxEventType,
} from "@prisma/client";
import {
  buildFlightArrivalLocation,
  calculatePickupActivationTime,
  formatFlightOperationalTime,
} from "../../../shared/flight-notification.helper";
import type { BookingWithRelations } from "../../../types";
import { CHAUFFEUR_RECIPIENT_TYPE } from "../notification.const";
import { NotificationType } from "../notification.interface";
import { NotificationService } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

const SUBTYPE = "CHAUFFEUR_ASSIGNED";

export type ChauffeurAssignedInput = {
  booking: BookingWithRelations & { flight?: Flight | null };
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

    const events: HandlerEvent[] = [];
    if (event.inbox || event.jobData) {
      events.push(event);
    }

    const flightBriefingEvent = this.buildFlightBriefingEvent(booking, chauffeurId);
    if (flightBriefingEvent) {
      events.push(flightBriefingEvent);
    }

    return events;
  }

  private buildFlightBriefingEvent(
    booking: ChauffeurAssignedInput["booking"],
    chauffeurId: string,
  ): HandlerEvent | null {
    const flight = booking.flight;
    if (booking.type !== BookingType.AIRPORT_PICKUP || !flight || !booking.chauffeur) {
      return null;
    }

    const expectedArrival =
      flight.actualArrival ?? flight.estimatedArrival ?? flight.scheduledArrival;
    const pickupActivationTime = calculatePickupActivationTime(expectedArrival);
    const arrivalLocation = buildFlightArrivalLocation(
      flight.destinationCodeIATA ?? flight.destinationCode,
      flight.arrivalTerminal,
      flight.arrivalGate,
    );
    const delay =
      flight.delayMinutes && flight.delayMinutes > 0
        ? `, currently delayed by ${flight.delayMinutes} minutes`
        : "";
    const jobData = this.notificationService.buildFlightUpdateJobData({
      statusEventId: `assignment-${chauffeurId}-${flight.lastUpdated.toISOString()}`,
      booking,
      recipientType: CHAUFFEUR_RECIPIENT_TYPE,
      type: NotificationType.FLIGHT_ASSIGNMENT_SNAPSHOT,
      title: "Airport pickup flight briefing",
      body: `${flight.flightNumber} is ${flight.status.toLowerCase().replaceAll("_", " ")}${delay}. Review the live flight details before pickup.`,
      flightNumber: flight.flightNumber,
      expectedArrival: formatFlightOperationalTime(expectedArrival),
      pickupActivationTime: formatFlightOperationalTime(pickupActivationTime),
      arrivalLocation,
    });
    if (!jobData) {
      return null;
    }

    return {
      jobData,
      dedupeKey: `flight-assignment:${booking.id}:${chauffeurId}:${flight.lastUpdated.toISOString()}`,
      userId: chauffeurId,
      subtype: NotificationType.FLIGHT_ASSIGNMENT_SNAPSHOT,
    };
  }
}
