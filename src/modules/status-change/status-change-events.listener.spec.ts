import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { observeBackgroundOperation } from "../../common/observability/background-operation";
import {
  type BookingConfirmedEventPayload,
  type FlightArrivalUpdatedEventPayload,
} from "../../shared/events/airport-activation.events";
import { StatusChangeEventsListener } from "./status-change-events.listener";
import { StatusChangeSchedulingService } from "./status-change-scheduling.service";

const { observeBackgroundOperationMock } = vi.hoisted(() => ({
  observeBackgroundOperationMock: vi.fn(
    async (_operation: string, _source: string, handler: () => Promise<unknown>) => handler(),
  ),
}));

vi.mock("../../common/observability/background-operation", () => ({
  observeBackgroundOperation: observeBackgroundOperationMock,
}));

describe("StatusChangeEventsListener", () => {
  let listener: StatusChangeEventsListener;
  let schedulingService: StatusChangeSchedulingService;

  beforeEach(async () => {
    vi.clearAllMocks();
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
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

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
      conflictedBookingIds: ["booking-conflict"],
    };

    await listener.onFlightArrivalUpdated(payload);

    expect(schedulingService.scheduleAirportActivationsForFlight).toHaveBeenCalledWith(
      "flight-1",
      new Date("2030-01-01T11:40:00.000Z"),
      ["booking-conflict"],
    );
  });

  it("captures and rethrows event handler failures", async () => {
    const error = new Error("redis down");
    vi.mocked(schedulingService.scheduleAirportActivation).mockRejectedValueOnce(error);

    const payload: BookingConfirmedEventPayload = {
      bookingId: "booking-1",
      bookingType: "AIRPORT_PICKUP",
      activationAt: "2030-01-01T11:40:00.000Z",
    };

    await expect(listener.onBookingConfirmed(payload)).rejects.toBe(error);
    expect(observeBackgroundOperation).toHaveBeenCalledWith(
      "StatusChangeEventsListener.onBookingConfirmed",
      "event",
      expect.any(Function),
    );
  });
});
