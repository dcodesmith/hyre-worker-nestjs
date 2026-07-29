import { createHash } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import { EventEmitter2, EventEmitterReadinessWatcher } from "@nestjs/event-emitter";
import { BookingStatus, BookingType, FlightStatus, PaymentStatus, Prisma } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { FLIGHT_ARRIVAL_UPDATED_EVENT } from "../../shared/events/airport-activation.events";
import {
  buildFlightArrivalLocation,
  calculatePickupActivationTime,
  formatFlightOperationalTime,
} from "../../shared/flight-notification.helper";
import { DatabaseService } from "../database/database.service";
import type { FlightStatusUpdatedInput } from "../notification/handlers/flight-status-updated.handler";
import { FlightStatusUpdatedHandler } from "../notification/handlers/flight-status-updated.handler";
import { NotificationType } from "../notification/notification.interface";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import type { FlightAwareEventCode, FlightAwareWebhookDto } from "./dto/flightaware-webhook.dto";
import type { FlightAwareWebhookResult } from "./flightaware.interface";

const MIN_CUSTOMER_DELAY_MINUTES = 30;
const MIN_OPERATIONAL_DELAY_MINUTES = 10;
const MIN_DELAY_CHANGE_MINUTES = 10;
const AUTHORITATIVE_ARRIVAL_EVENT_CODES = new Set<FlightAwareEventCode>(["arrival", "on", "in"]);
const AUTHORITATIVE_DEPARTURE_EVENT_CODES = new Set<FlightAwareEventCode>([
  "departure",
  "out",
  "off",
]);
const NOTIFIABLE_BOOKING_STATUSES = new Set<BookingStatus>([
  BookingStatus.CONFIRMED,
  BookingStatus.ACTIVE,
]);

type FlightNotificationSnapshot = {
  flightNumber: string;
  destinationCode: string;
  destinationCodeIATA: string | null;
  status: FlightStatus;
  delayMinutes: number | null;
  arrivalGate: string | null;
  arrivalTerminal: string | null;
  scheduledArrival: Date;
  estimatedArrival: Date | null;
  actualArrival: Date | null;
};
type FlightUpdateNotification = FlightStatusUpdatedInput["notifications"][number];

@Injectable()
export class FlightAwareWebhookService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly flightStatusUpdatedHandler: FlightStatusUpdatedHandler,
    private readonly eventEmitter: EventEmitter2,
    private readonly eventEmitterReadinessWatcher: EventEmitterReadinessWatcher,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FlightAwareWebhookService.name);
  }

  async handleWebhook(
    payload: FlightAwareWebhookDto,
    expectedFlightId: string,
  ): Promise<FlightAwareWebhookResult> {
    const { alert_id, event_code, flight } = payload;

    const flightRecord = await this.databaseService.flight.findFirst({
      where: {
        id: expectedFlightId,
        alertId: String(alert_id),
        alertEnabled: true,
      },
      select: {
        id: true,
      },
    });

    if (!flightRecord) {
      throw new NotFoundException("Flight not found");
    }

    const eventTime = new Date();
    const eventKey = this.createEventKey(payload);

    const txResult = await this.databaseService.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Flight" WHERE "id" = ${flightRecord.id} FOR UPDATE`;
      const currentFlight = await tx.flight.findUniqueOrThrow({
        where: { id: flightRecord.id },
        select: {
          flightNumber: true,
          destinationCode: true,
          destinationCodeIATA: true,
          status: true,
          delayMinutes: true,
          arrivalGate: true,
          arrivalTerminal: true,
          scheduledArrival: true,
          estimatedArrival: true,
          actualArrival: true,
        },
      });
      const arrivalDelayMinutes = this.resolveArrivalDelayMinutes(flight, currentFlight);
      const oldStatus = currentFlight.status;
      const newStatus = this.mapEventCodeToStatus(
        event_code,
        currentFlight.status,
        flight.cancelled,
      );
      const flightUpdateData = this.buildFlightUpdateData(flight, newStatus, arrivalDelayMinutes);
      const expectedArrival = this.resolveExpectedArrivalTime(flight, currentFlight);
      const activationAt = calculatePickupActivationTime(expectedArrival);
      const created = await tx.flightStatusEvent.createMany({
        data: [
          {
            eventKey,
            flightId: flightRecord.id,
            eventType: event_code,
            eventTime,
            eventData: payload,
            oldStatus,
            newStatus,
            delayChange: arrivalDelayMinutes,
            processed: false,
            notificationsSent: false,
          },
        ],
        skipDuplicates: true,
      });
      const statusEvent = await tx.flightStatusEvent.findUniqueOrThrow({
        where: { eventKey },
        select: {
          id: true,
          processed: true,
        },
      });
      const eligibleBookingWhere: Prisma.BookingWhereInput = {
        flightId: flightRecord.id,
        type: BookingType.AIRPORT_PICKUP,
        status: { in: [...NOTIFIABLE_BOOKING_STATUSES] },
        paymentStatus: PaymentStatus.PAID,
        deletedAt: null,
      };

      if (created.count === 0 && statusEvent.processed) {
        const bookingCount = await tx.booking.count({ where: eligibleBookingWhere });
        return {
          duplicate: true as const,
          statusEventId: statusEvent.id,
          oldStatus: currentFlight.status,
          resolvedStatus: currentFlight.status,
          bookingCount,
          activationAt: null,
        };
      }

      const notifications = this.buildNotifications(
        event_code,
        flight,
        currentFlight,
        arrivalDelayMinutes,
        newStatus,
      );
      const bookings = await tx.booking.findMany({
        where: eligibleBookingWhere,
        include: {
          user: true,
          chauffeur: true,
          car: { include: { owner: true } },
          legs: { include: { extensions: true } },
        },
      });

      await tx.flight.update({
        where: { id: flightRecord.id },
        data: flightUpdateData,
      });

      await this.notificationOutboxService.create(
        this.flightStatusUpdatedHandler,
        {
          statusEventId: statusEvent.id,
          flightId: flightRecord.id,
          flightNumber: currentFlight.flightNumber,
          expectedArrival: formatFlightOperationalTime(expectedArrival),
          pickupActivationTime: formatFlightOperationalTime(activationAt),
          arrivalLocation: this.buildArrivalLocation(flight, currentFlight),
          bookings,
          notifications,
        },
        tx,
      );

      await tx.flightStatusEvent.update({
        where: { id: statusEvent.id },
        data: {
          oldStatus,
          newStatus,
          delayChange: arrivalDelayMinutes,
          eventData: payload,
          processed: true,
        },
      });

      return {
        duplicate: false as const,
        statusEventId: statusEvent.id,
        oldStatus,
        resolvedStatus: newStatus,
        bookingCount: bookings.length,
        activationAt,
      };
    });

    if (
      !txResult.duplicate &&
      txResult.activationAt &&
      this.shouldEmitActivationEvent(txResult.resolvedStatus)
    ) {
      try {
        await this.eventEmitterReadinessWatcher.waitUntilReady();
        // Intentionally fire-and-forget: webhook processing should not wait for listener processing.
        this.eventEmitter.emit(FLIGHT_ARRIVAL_UPDATED_EVENT, {
          flightId: flightRecord.id,
          activationAt: txResult.activationAt.toISOString(),
        });
      } catch (error) {
        this.logger.error(
          {
            flightId: flightRecord.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to emit flight arrival updated event",
        );
      }
    }

    this.logger.info(
      {
        flightId: flightRecord.id,
        eventType: event_code,
        oldStatus: txResult.oldStatus,
        newStatus: txResult.resolvedStatus,
        statusEventId: txResult.statusEventId,
        bookingCount: txResult.bookingCount,
      },
      "Processed FlightAware webhook event",
    );

    return {
      duplicate: txResult.duplicate,
      flightId: flightRecord.id,
      bookingCount: txResult.bookingCount,
      newStatus: txResult.resolvedStatus,
    };
  }

  private mapEventCodeToStatus(
    eventCode: FlightAwareEventCode,
    currentStatus: FlightStatus,
    cancelled?: boolean,
  ): FlightStatus {
    if (currentStatus === FlightStatus.LANDED || currentStatus === FlightStatus.DIVERTED) {
      return currentStatus;
    }

    if (currentStatus === FlightStatus.CANCELLED) {
      return eventCode === "change" && cancelled === false ? FlightStatus.SCHEDULED : currentStatus;
    }

    if (eventCode === "cancelled") {
      return FlightStatus.CANCELLED;
    }

    if (eventCode === "diverted") {
      return FlightStatus.DIVERTED;
    }

    if (AUTHORITATIVE_ARRIVAL_EVENT_CODES.has(eventCode)) {
      return FlightStatus.LANDED;
    }

    if (AUTHORITATIVE_DEPARTURE_EVENT_CODES.has(eventCode)) {
      return FlightStatus.DEPARTED;
    }

    return currentStatus;
  }

  private createEventKey(payload: FlightAwareWebhookDto): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          alertId: payload.alert_id,
          eventCode: payload.event_code,
          flight: payload.flight,
        }),
      )
      .digest("hex");
  }

  private resolveArrivalDelayMinutes(
    flight: FlightAwareWebhookDto["flight"],
    previous: FlightNotificationSnapshot,
  ): number | null {
    const hasCurrentArrivalUpdate = ["actual_in", "actual_on", "estimated_in", "estimated_on"].some(
      (field) => field in flight,
    );
    const hasScheduledArrivalUpdate = ["scheduled_in", "scheduled_on"].some(
      (field) => field in flight,
    );
    const currentArrival = hasCurrentArrivalUpdate
      ? this.parseDate(
          flight.actual_in || flight.actual_on || flight.estimated_in || flight.estimated_on,
        )
      : (previous.actualArrival ?? previous.estimatedArrival);
    const scheduledArrival = hasScheduledArrivalUpdate
      ? this.parseDate(flight.scheduled_in || flight.scheduled_on)
      : previous.scheduledArrival;

    if (!currentArrival || !scheduledArrival) {
      return null;
    }

    return Math.round((currentArrival.getTime() - scheduledArrival.getTime()) / 60_000);
  }

  private buildNotifications(
    eventCode: FlightAwareEventCode,
    flight: FlightAwareWebhookDto["flight"],
    previous: FlightNotificationSnapshot,
    delayMinutes: number | null,
    newStatus: FlightStatus,
  ): FlightStatusUpdatedInput["notifications"] {
    const statusNotification = this.buildStatusNotification(eventCode, flight, previous, newStatus);
    if (statusNotification) {
      return [statusNotification];
    }

    if (eventCode !== "change") {
      return [];
    }

    return this.buildChangeNotifications(flight, previous, delayMinutes);
  }

  private buildStatusNotification(
    eventCode: FlightAwareEventCode,
    flight: FlightAwareWebhookDto["flight"],
    previous: FlightNotificationSnapshot,
    newStatus: FlightStatus,
  ): FlightUpdateNotification | null {
    const flightNumber = previous.flightNumber;
    const serviceReviewMessage =
      "We are reviewing your airport pickup and will contact you if the booking needs to change.";

    if (
      eventCode === "cancelled" &&
      newStatus === FlightStatus.CANCELLED &&
      previous.status !== FlightStatus.CANCELLED
    ) {
      return {
        type: NotificationType.FLIGHT_CANCELLED,
        operationalTitle: "Pickup flight cancelled",
        operationalBody: `${flightNumber} has been cancelled. Review the airport pickup immediately.`,
        customerTitle: "Your pickup flight was cancelled",
        customerBody: `${flightNumber} has been cancelled. ${serviceReviewMessage}`,
      };
    }

    if (
      eventCode === "change" &&
      flight.cancelled === false &&
      newStatus === FlightStatus.SCHEDULED &&
      previous.status === FlightStatus.CANCELLED
    ) {
      return {
        type: NotificationType.FLIGHT_REINSTATED,
        operationalTitle: "Pickup flight reinstated",
        operationalBody: `${flightNumber} is operating again. Recheck the airport pickup timing and assignment.`,
        customerTitle: "Your pickup flight is operating again",
        customerBody: `${flightNumber} is no longer cancelled. We are tracking it and reviewing your pickup timing.`,
      };
    }

    if (
      eventCode === "diverted" &&
      newStatus === FlightStatus.DIVERTED &&
      previous.status !== FlightStatus.DIVERTED
    ) {
      return {
        type: NotificationType.FLIGHT_DIVERTED,
        operationalTitle: "Pickup flight diverted",
        operationalBody: `${flightNumber} has been diverted. Review the pickup location and contact the customer.`,
        customerTitle: "Your pickup flight was diverted",
        customerBody: `${flightNumber} has been diverted. ${serviceReviewMessage}`,
      };
    }

    if (
      newStatus === FlightStatus.DEPARTED &&
      previous.status !== FlightStatus.DEPARTED &&
      AUTHORITATIVE_DEPARTURE_EVENT_CODES.has(eventCode)
    ) {
      return {
        type: NotificationType.FLIGHT_DEPARTED,
        operationalTitle: "Pickup flight departed",
        operationalBody: `${flightNumber} has departed. Monitor its expected arrival and pickup activation time.`,
      };
    }

    if (
      newStatus === FlightStatus.LANDED &&
      previous.status !== FlightStatus.LANDED &&
      AUTHORITATIVE_ARRIVAL_EVENT_CODES.has(eventCode)
    ) {
      const destination = previous.destinationCodeIATA ?? previous.destinationCode;
      const gate = flight.gate_destination ? ` at gate ${flight.gate_destination}` : "";
      return {
        type: NotificationType.FLIGHT_ARRIVED,
        operationalTitle: "Pickup flight arrived",
        operationalBody: `${flightNumber} has arrived at ${destination}${gate}. Prepare for the customer pickup.`,
      };
    }

    return null;
  }

  private buildChangeNotifications(
    flight: FlightAwareWebhookDto["flight"],
    previous: FlightNotificationSnapshot,
    delayMinutes: number | null,
  ): FlightStatusUpdatedInput["notifications"] {
    const notifications: FlightUpdateNotification[] = [];
    const delayNotification = this.buildDelayNotification(previous, delayMinutes);
    if (delayNotification) {
      notifications.push(delayNotification);
    }
    const gateNotification = this.buildGateNotification(flight, previous);
    if (gateNotification) {
      notifications.push(gateNotification);
    }
    const terminalNotification = this.buildTerminalNotification(flight, previous);
    if (terminalNotification) {
      notifications.push(terminalNotification);
    }
    return notifications;
  }

  private buildDelayNotification(
    previous: FlightNotificationSnapshot,
    delayMinutes: number | null,
  ): FlightUpdateNotification | null {
    if (delayMinutes === null) {
      return null;
    }
    const previousDelay = previous.delayMinutes ?? 0;
    const delayChangedEnough =
      previous.delayMinutes === null ||
      Math.abs(delayMinutes - previousDelay) >= MIN_DELAY_CHANGE_MINUTES;
    if (!delayChangedEnough) {
      return null;
    }

    const flightNumber = previous.flightNumber;
    if (delayMinutes >= MIN_OPERATIONAL_DELAY_MINUTES) {
      const customerNeedsUpdate =
        delayMinutes >= MIN_CUSTOMER_DELAY_MINUTES || previousDelay >= MIN_CUSTOMER_DELAY_MINUTES;
      return {
        type: NotificationType.FLIGHT_DELAYED,
        operationalTitle:
          previousDelay > 0 ? "Pickup flight delay updated" : "Pickup flight delayed",
        operationalBody: `${flightNumber} is delayed by ${this.formatMinutes(delayMinutes)}. Pickup timing has been recalculated.`,
        customerTitle: customerNeedsUpdate ? "Your pickup flight timing changed" : undefined,
        customerBody: customerNeedsUpdate
          ? `${flightNumber} is delayed by ${this.formatMinutes(delayMinutes)}. We are tracking it and have adjusted your pickup timing.`
          : undefined,
      };
    }

    if (previousDelay < MIN_OPERATIONAL_DELAY_MINUTES) {
      return null;
    }
    const customerNeedsUpdate = previousDelay >= MIN_CUSTOMER_DELAY_MINUTES;
    const recoveredDelayMinutes = Math.max(delayMinutes, 0);
    return {
      type: NotificationType.FLIGHT_DELAY_RECOVERED,
      operationalTitle: "Pickup flight delay cleared",
      operationalBody: `${flightNumber}'s reported delay is now ${this.formatMinutes(recoveredDelayMinutes)}. Pickup timing has been recalculated.`,
      customerTitle: customerNeedsUpdate ? "Your pickup flight delay improved" : undefined,
      customerBody: customerNeedsUpdate
        ? `${flightNumber}'s reported delay is now ${this.formatMinutes(recoveredDelayMinutes)}. We have updated your pickup timing.`
        : undefined,
    };
  }

  private buildGateNotification(
    flight: FlightAwareWebhookDto["flight"],
    previous: FlightNotificationSnapshot,
  ): FlightUpdateNotification | null {
    if (
      !("gate_destination" in flight) ||
      flight.gate_destination === undefined ||
      flight.gate_destination === previous.arrivalGate
    ) {
      return null;
    }
    const gate = flight.gate_destination;
    return {
      type: NotificationType.FLIGHT_GATE_CHANGED,
      operationalTitle: gate ? "Pickup flight arrival gate updated" : "Arrival gate removed",
      operationalBody: gate
        ? `${previous.flightNumber} will arrive at gate ${gate}.`
        : `${previous.flightNumber}'s arrival gate is no longer assigned. Check FlightAware before pickup.`,
    };
  }

  private buildTerminalNotification(
    flight: FlightAwareWebhookDto["flight"],
    previous: FlightNotificationSnapshot,
  ): FlightUpdateNotification | null {
    if (
      !("terminal_destination" in flight) ||
      flight.terminal_destination === undefined ||
      flight.terminal_destination === previous.arrivalTerminal
    ) {
      return null;
    }
    const terminal = flight.terminal_destination;
    return {
      type: NotificationType.FLIGHT_TERMINAL_CHANGED,
      operationalTitle: terminal ? "Pickup flight terminal updated" : "Arrival terminal removed",
      operationalBody: terminal
        ? `${previous.flightNumber} will arrive at terminal ${terminal}.`
        : `${previous.flightNumber}'s arrival terminal is no longer assigned. Check FlightAware before pickup.`,
    };
  }

  private formatMinutes(minutes: number): string {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  private parseDate(value?: string): Date | null {
    if (!value) {
      return null;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private buildFlightUpdateData(
    flight: FlightAwareWebhookDto["flight"],
    newStatus: FlightStatus,
    delayMinutes: number | null,
  ): Prisma.FlightUpdateInput {
    const hasDelayUpdate = [
      "scheduled_in",
      "scheduled_on",
      "estimated_in",
      "estimated_on",
      "actual_in",
      "actual_on",
    ].some((field) => field in flight);
    const hasArrivalGateUpdate = "gate_destination" in flight;
    const hasDepartureGateUpdate = "gate_origin" in flight;
    const hasArrivalTerminalUpdate = "terminal_destination" in flight;

    return {
      status: newStatus,
      scheduledDeparture: this.parseDate(flight.scheduled_out || flight.scheduled_off) ?? undefined,
      scheduledArrival: this.parseDate(flight.scheduled_in || flight.scheduled_on) ?? undefined,
      estimatedDeparture: this.parseDate(flight.estimated_out || flight.estimated_off) ?? undefined,
      estimatedArrival: this.parseDate(flight.estimated_in || flight.estimated_on) ?? undefined,
      actualDeparture: this.parseDate(flight.actual_out || flight.actual_off) ?? undefined,
      actualArrival: this.parseDate(flight.actual_in || flight.actual_on) ?? undefined,
      delayMinutes: hasDelayUpdate ? delayMinutes : undefined,
      arrivalGate: hasArrivalGateUpdate ? flight.gate_destination : undefined,
      departureGate: hasDepartureGateUpdate ? flight.gate_origin : undefined,
      arrivalTerminal: hasArrivalTerminalUpdate ? flight.terminal_destination : undefined,
      aircraftType: flight.aircraft_type,
      registration: flight.registration,
      isLive: true,
    };
  }

  private shouldEmitActivationEvent(status: FlightStatus): boolean {
    return status !== FlightStatus.CANCELLED && status !== FlightStatus.DIVERTED;
  }

  private resolveExpectedArrivalTime(
    flight: FlightAwareWebhookDto["flight"],
    previous: FlightNotificationSnapshot,
  ): Date | null {
    const arrivalTime =
      flight.actual_in ||
      flight.actual_on ||
      flight.estimated_in ||
      flight.estimated_on ||
      flight.scheduled_in ||
      flight.scheduled_on;

    return (
      this.parseDate(arrivalTime) ??
      previous.actualArrival ??
      previous.estimatedArrival ??
      previous.scheduledArrival
    );
  }

  private buildArrivalLocation(
    flight: FlightAwareWebhookDto["flight"],
    previous: FlightNotificationSnapshot,
  ): string {
    const destination = previous.destinationCodeIATA ?? previous.destinationCode;
    const terminal =
      "terminal_destination" in flight ? flight.terminal_destination : previous.arrivalTerminal;
    const gate = "gate_destination" in flight ? flight.gate_destination : previous.arrivalGate;
    return buildFlightArrivalLocation(destination, terminal, gate);
  }
}
