import { Injectable } from "@nestjs/common";
import { BookingType, NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import { formatFlightOperationalTime } from "../../../shared/flight-notification.helper";
import type { BookingWithRelations } from "../../../types";
import { CHAUFFEUR_RECIPIENT_TYPE } from "../notification.const";
import { NotificationType } from "../notification.interface";
import { NotificationService } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

const SUBTYPE = "BOOKING_STATUS_CHANGED";

export type BookingStatusChangedInput = {
  booking: BookingWithRelations;
  oldStatus: string;
  newStatus: string;
  showReviewRequest?: boolean;
  includeChauffeurCompletionLink?: boolean;
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
    includeChauffeurCompletionLink = false,
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

    const events: HandlerEvent[] = [];
    if (event.inbox || event.jobData) {
      events.push(event);
    }

    if (
      includeChauffeurCompletionLink &&
      booking.type === BookingType.AIRPORT_PICKUP &&
      booking.chauffeurId
    ) {
      const chauffeurJob = this.notificationService.buildFlightUpdateJobData({
        statusEventId: `airport-active-${booking.updatedAt.toISOString()}`,
        booking,
        recipientType: CHAUFFEUR_RECIPIENT_TYPE,
        type: NotificationType.FLIGHT_ASSIGNMENT_SNAPSHOT,
        title: "Airport trip ready",
        body: "After drop-off, use your secure link to complete this trip.",
        flightNumber: booking.flightNumber ?? "Airport pickup",
        expectedArrival: formatFlightOperationalTime(booking.startDate),
        pickupActivationTime: formatFlightOperationalTime(booking.startDate),
        arrivalLocation: booking.pickupLocation,
      });
      if (chauffeurJob) {
        chauffeurJob.airportCompletionLink = true;
        events.push({
          jobData: chauffeurJob,
          dedupeKey: `airport-completion-link:${booking.id}:${booking.chauffeurId}:${booking.updatedAt.toISOString()}`,
          userId: booking.chauffeurId,
          subtype: "AIRPORT_COMPLETION_LINK",
        });
      }
    }

    return events;
  }
}
