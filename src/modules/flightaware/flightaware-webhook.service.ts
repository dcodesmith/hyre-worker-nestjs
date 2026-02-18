import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { FlightStatus, Prisma } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import type { FlightAwareWebhookDto } from "./dto/flightaware-webhook.dto";
import { apEventTypeToStatus, FlightAwareWebhookResult } from "./flightaware.interface";

@Injectable()
export class FlightAwareWebhookService {
  private readonly logger = new Logger(FlightAwareWebhookService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async handleWebhook(payload: FlightAwareWebhookDto): Promise<FlightAwareWebhookResult> {
    const { alert_id, event_type, event_time, flight } = payload;

    const flightRecord = await this.databaseService.flight.findFirst({
      where: { alertId: alert_id },
      select: {
        id: true,
        status: true,
      },
    });

    if (!flightRecord) {
      throw new NotFoundException("Flight not found");
    }

    const eventTime = new Date(event_time);
    const newStatus = this.mapEventTypeToStatus({
      eventType: event_type,
      flightStatus: flight.status,
      flightId: flight.fa_flight_id,
      callSign: flight.ident,
      eventTime,
    });
    const oldStatus = flightRecord.status;
    const eventLookup = {
      flightId: flightRecord.id,
      eventType: event_type,
      eventTime,
    };
    const flightUpdateData = this.buildFlightUpdateData(flight, newStatus);

    const txResult = await this.databaseService.$transaction(async (tx) => {
      try {
        const createdEvent = await tx.flightStatusEvent.create({
          data: {
            flightId: flightRecord.id,
            eventType: event_type,
            eventTime,
            eventData: payload,
            oldStatus,
            newStatus,
            delayChange: flight.delay_minutes ?? null,
            processed: false,
            notificationsSent: false,
          },
          select: { id: true },
        });

        await tx.flight.update({
          where: { id: flightRecord.id },
          data: flightUpdateData,
        });

        await tx.flightStatusEvent.update({
          where: { id: createdEvent.id },
          data: {
            processed: true,
            notificationsSent: false,
          },
        });

        return {
          duplicate: false as const,
          statusEventId: createdEvent.id,
          resolvedStatus: newStatus,
        };
      } catch (error) {
        if (!this.isUniqueConstraintError(error)) {
          throw error;
        }

        const existingEvent = await tx.flightStatusEvent.findFirst({
          where: eventLookup,
          select: {
            id: true,
            processed: true,
            newStatus: true,
          },
        });

        if (!existingEvent) {
          throw error;
        }

        if (existingEvent.processed) {
          return {
            duplicate: true as const,
            statusEventId: existingEvent.id,
            resolvedStatus: existingEvent.newStatus ?? flightRecord.status,
          };
        }

        await tx.flight.update({
          where: { id: flightRecord.id },
          data: flightUpdateData,
        });

        await tx.flightStatusEvent.update({
          where: { id: existingEvent.id },
          data: {
            oldStatus,
            newStatus,
            delayChange: flight.delay_minutes ?? null,
            eventData: payload,
            processed: true,
            notificationsSent: false,
          },
        });

        return {
          duplicate: false as const,
          statusEventId: existingEvent.id,
          resolvedStatus: newStatus,
        };
      }
    });

    const bookingCount = await this.databaseService.booking.count({
      where: {
        flightId: flightRecord.id,
        deletedAt: null,
      },
    });

    this.logger.log("Processed FlightAware webhook event", {
      flightId: flightRecord.id,
      eventType: event_type,
      oldStatus,
      newStatus,
      statusEventId: txResult.statusEventId,
      bookingCount,
    });

    return {
      duplicate: txResult.duplicate,
      flightId: flightRecord.id,
      bookingCount,
      newStatus: txResult.resolvedStatus,
    };
  }

  private mapEventTypeToStatus({
    eventType,
    flightStatus,
    flightId,
    callSign,
    eventTime,
  }: apEventTypeToStatus): FlightStatus {
    const normalizedEventType = eventType.toLowerCase();

    if (normalizedEventType.includes("departure") || normalizedEventType === "departed") {
      return FlightStatus.DEPARTED;
    }

    if (normalizedEventType.includes("arrival") || normalizedEventType === "arrived") {
      return FlightStatus.LANDED;
    }

    if (normalizedEventType.includes("cancel")) {
      return FlightStatus.CANCELLED;
    }

    if (normalizedEventType.includes("divert")) {
      return FlightStatus.DIVERTED;
    }

    if (flightStatus) {
      const normalizedFlightStatus = flightStatus.toLowerCase().replaceAll(/[\s_-]/g, "");

      if (
        normalizedFlightStatus.includes("enroute") ||
        normalizedFlightStatus.includes("airborne") ||
        normalizedFlightStatus === "active"
      ) {
        return FlightStatus.EN_ROUTE;
      }

      if (normalizedFlightStatus.includes("landed") || normalizedFlightStatus.includes("arrived")) {
        return FlightStatus.LANDED;
      }
    }

    this.logger.warn("Unknown FlightAware event type, defaulting to SCHEDULED", {
      eventType,
      flightId,
      callSign,
      eventTime: eventTime?.toISOString(),
    });

    return FlightStatus.SCHEDULED;
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
  ): Prisma.FlightUpdateInput {
    return {
      status: newStatus,
      estimatedDeparture: this.parseDate(flight.estimated_off) ?? undefined,
      estimatedArrival: this.parseDate(flight.estimated_in || flight.estimated_on) ?? undefined,
      actualDeparture: this.parseDate(flight.actual_off) ?? undefined,
      actualArrival: this.parseDate(flight.actual_in || flight.actual_on) ?? undefined,
      delayMinutes: flight.delay_minutes,
      arrivalGate: flight.gate_destination,
      departureGate: flight.gate_origin,
      aircraftType: flight.aircraft_type,
      registration: flight.registration,
    };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
}
