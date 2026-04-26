import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BookingConfirmedEventPayload,
  type FlightArrivalUpdatedEventPayload,
} from "../../shared/events/airport-activation.events";
import { StatusChangeEventsListener } from "./status-change-events.listener";
import { StatusChangeSchedulingService } from "./status-change-scheduling.service";

describe("StatusChangeEventsListener", () => {
  let listener: StatusChangeEventsListener;
  let schedulingService: StatusChangeSchedulingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusChangeEventsListener,
        {
          provide: StatusChangeSchedulingService,
          useValue: {
            scheduleAirportActivation: vi.fn(),
            scheduleAirportActivationsForFlight: vi.fn(),
          },
        },
      ],
    }).compile();

    listener = module.get<StatusChangeEventsListener>(StatusChangeEventsListener);
    schedulingService = module.get<StatusChangeSchedulingService>(StatusChangeSchedulingService);
  });

  it("handles booking confirmed event for airport pickup", async () => {
    const payload: BookingConfirmedEventPayload = {
      bookingId: "booking-1",
      bookingType: "AIRPORT_PICKUP",
      activationAt: "2030-01-01T11:40:00.000Z",
    };

    await listener.onBookingConfirmed(payload);

    expect(schedulingService.scheduleAirportActivation).toHaveBeenCalledWith(
      "booking-1",
      new Date("2030-01-01T11:40:00.000Z"),
    );
  });

  it("ignores booking confirmed event for non-airport pickup", async () => {
    const payload: BookingConfirmedEventPayload = {
      bookingId: "booking-2",
      bookingType: "DAY",
      activationAt: "2030-01-01T11:40:00.000Z",
    };

    await listener.onBookingConfirmed(payload);

    expect(schedulingService.scheduleAirportActivation).not.toHaveBeenCalled();
  });

  it("handles flight arrival updated event", async () => {
    const payload: FlightArrivalUpdatedEventPayload = {
      flightId: "flight-1",
      activationAt: "2030-01-01T11:40:00.000Z",
    };

    await listener.onFlightArrivalUpdated(payload);

    expect(schedulingService.scheduleAirportActivationsForFlight).toHaveBeenCalledWith(
      "flight-1",
      new Date("2030-01-01T11:40:00.000Z"),
    );
  });
});
