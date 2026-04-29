import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PinoLogger } from "nestjs-pino";
import {
  BOOKING_CONFIRMED_EVENT,
  type BookingConfirmedEventPayload,
  FLIGHT_ARRIVAL_UPDATED_EVENT,
  type FlightArrivalUpdatedEventPayload,
} from "../../shared/events/airport-activation.events";
import { StatusChangeSchedulingService } from "./status-change-scheduling.service";

@Injectable()
export class StatusChangeEventsListener {
  constructor(
    private readonly schedulingService: StatusChangeSchedulingService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StatusChangeEventsListener.name);
  }

  @OnEvent(BOOKING_CONFIRMED_EVENT, { suppressErrors: true })
  async onBookingConfirmed(payload: BookingConfirmedEventPayload): Promise<void> {
    if (payload.bookingType !== "AIRPORT_PICKUP" || !payload.activationAt) {
      return;
    }

    const activationAt = new Date(payload.activationAt);
    if (Number.isNaN(activationAt.getTime())) {
      this.logger.warn(
        { payload },
        "Invalid airport activation timestamp in booking.confirmed event",
      );
      return;
    }

    await this.schedulingService.scheduleAirportActivation(payload.bookingId, activationAt);
  }

  @OnEvent(FLIGHT_ARRIVAL_UPDATED_EVENT, { suppressErrors: true })
  async onFlightArrivalUpdated(payload: FlightArrivalUpdatedEventPayload): Promise<void> {
    const activationAt = new Date(payload.activationAt);
    if (Number.isNaN(activationAt.getTime())) {
      this.logger.warn(
        { payload },
        "Invalid airport activation timestamp in flight.arrival-updated event",
      );
      return;
    }

    await this.schedulingService.scheduleAirportActivationsForFlight(
      payload.flightId,
      activationAt,
    );
  }
}
