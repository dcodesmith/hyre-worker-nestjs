import { Injectable } from "@nestjs/common";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import type { BookingWithRelations } from "../../../types";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  FLEET_OWNER_RECIPIENT_TYPE,
} from "../notification.const";
import type { FlightNotificationType, NotificationJobData } from "../notification.interface";
import { NotificationService } from "../notification.service";
import type { RecipientType } from "../template-data.interface";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

export type FlightStatusUpdatedInput = {
  statusEventId: string;
  flightId: string;
  flightNumber: string;
  expectedArrival: string;
  pickupActivationTime: string;
  arrivalLocation: string;
  bookings: BookingWithRelations[];
  notifications: Array<{
    type: FlightNotificationType;
    operationalTitle: string;
    operationalBody: string;
    customerTitle?: string;
    customerBody?: string;
  }>;
};

@Injectable()
export class FlightStatusUpdatedHandler implements OutboxEventHandler<FlightStatusUpdatedInput> {
  readonly eventType = NotificationOutboxEventType.BOOKING_LIFECYCLE;

  constructor(private readonly notificationService: NotificationService) {}

  async buildEvents(input: FlightStatusUpdatedInput): Promise<HandlerEvent[]> {
    const events: HandlerEvent[] = [];

    for (const notification of input.notifications) {
      for (const booking of input.bookings) {
        this.addOperationalEvent(events, input, booking, notification, FLEET_OWNER_RECIPIENT_TYPE);
        if (booking.chauffeur) {
          this.addOperationalEvent(events, input, booking, notification, CHAUFFEUR_RECIPIENT_TYPE);
        }
        this.addCustomerEvent(events, input, booking, notification);
      }
    }

    return events;
  }

  private addOperationalEvent(
    events: HandlerEvent[],
    input: FlightStatusUpdatedInput,
    booking: BookingWithRelations,
    notification: FlightStatusUpdatedInput["notifications"][number],
    recipientType: typeof FLEET_OWNER_RECIPIENT_TYPE | typeof CHAUFFEUR_RECIPIENT_TYPE,
  ): void {
    const jobData = this.buildJobData(
      input,
      booking,
      notification.type,
      recipientType,
      notification.operationalTitle,
      notification.operationalBody,
    );
    if (!jobData) {
      return;
    }

    const recipientUserId =
      recipientType === FLEET_OWNER_RECIPIENT_TYPE ? booking.car.owner.id : booking.chauffeur?.id;
    if (!recipientUserId) {
      return;
    }

    events.push({
      jobData,
      dedupeKey: this.buildDedupeKey(input, booking.id, notification.type, recipientType),
      userId: recipientUserId,
      subtype: notification.type,
    });
  }

  private addCustomerEvent(
    events: HandlerEvent[],
    input: FlightStatusUpdatedInput,
    booking: BookingWithRelations,
    notification: FlightStatusUpdatedInput["notifications"][number],
  ): void {
    const userId = booking.userId ?? booking.user?.id;
    if (!userId || !notification.customerTitle || !notification.customerBody) {
      return;
    }

    const jobData = this.buildJobData(
      input,
      booking,
      notification.type,
      CLIENT_RECIPIENT_TYPE,
      notification.customerTitle,
      notification.customerBody,
    );
    const dedupeKey = this.buildDedupeKey(
      input,
      booking.id,
      notification.type,
      CLIENT_RECIPIENT_TYPE,
    );

    events.push({
      jobData: jobData ?? undefined,
      inbox: {
        userId,
        type: NotificationInboxType.BOOKING_LIFECYCLE,
        title: notification.customerTitle,
        body: notification.customerBody,
        payload: {
          bookingId: booking.id,
          flightId: input.flightId,
          notificationType: notification.type,
        },
      },
      dedupeKey,
      userId,
      subtype: notification.type,
    });
  }

  private buildJobData(
    input: FlightStatusUpdatedInput,
    booking: BookingWithRelations,
    type: FlightNotificationType,
    recipientType: RecipientType,
    title: string,
    body: string,
  ): NotificationJobData | null {
    return this.notificationService.buildFlightUpdateJobData({
      statusEventId: input.statusEventId,
      booking,
      recipientType,
      type,
      title,
      body,
      flightNumber: input.flightNumber,
      expectedArrival: input.expectedArrival,
      pickupActivationTime: input.pickupActivationTime,
      arrivalLocation: input.arrivalLocation,
    });
  }

  private buildDedupeKey(
    input: FlightStatusUpdatedInput,
    bookingId: string,
    type: FlightNotificationType,
    recipientType: RecipientType,
  ): string {
    return `flight-update:${input.statusEventId}:${type}:${bookingId}:${recipientType}`;
  }
}
