import { EventEmitter2, EventEmitterReadinessWatcher } from "@nestjs/event-emitter";
import { Test, type TestingModule } from "@nestjs/testing";
import { FlightStatus, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FLIGHT_ARRIVAL_UPDATED_EVENT } from "../../shared/events/airport-activation.events";
import { DatabaseService } from "../database/database.service";
import { FlightAwareWebhookService } from "./flightaware-webhook.service";

type MockDatabaseService = {
  flight: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  flightStatusEvent: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  booking: {
    count: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

describe("FlightAwareWebhookService", () => {
  let service: FlightAwareWebhookService;
  let databaseService: MockDatabaseService;
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let eventEmitterReadinessWatcher: EventEmitterReadinessWatcher;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightAwareWebhookService,
        {
          provide: DatabaseService,
          useValue: {
            flight: {
              findFirst: vi.fn(),
            },
            flightStatusEvent: {
              findFirst: vi.fn(),
            },
            booking: {
              count: vi.fn(),
            },
            $transaction: vi.fn(),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: vi.fn(),
          },
        },
        {
          provide: EventEmitterReadinessWatcher,
          useValue: {
            waitUntilReady: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<FlightAwareWebhookService>(FlightAwareWebhookService);
    databaseService = module.get(DatabaseService);
    eventEmitter = module.get(EventEmitter2);
    eventEmitterReadinessWatcher = module.get<EventEmitterReadinessWatcher>(
      EventEmitterReadinessWatcher,
    );
  });

  it("returns duplicate result when unique conflict hits already-processed event", async () => {
    vi.mocked(databaseService.flight.findFirst).mockResolvedValueOnce({
      id: "flight-1",
      status: FlightStatus.SCHEDULED,
    });
    vi.mocked(databaseService.booking.count).mockResolvedValueOnce(1);
    vi.mocked(databaseService.$transaction).mockImplementationOnce(async (callback) =>
      callback({
        flight: {
          update: vi.fn(),
        },
        flightStatusEvent: {
          create: vi.fn().mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError("Unique violation", {
              code: "P2002",
              clientVersion: "test",
            }),
          ),
          findFirst: vi.fn().mockResolvedValue({
            id: "event-1",
            processed: true,
            newStatus: FlightStatus.SCHEDULED,
          }),
          update: vi.fn(),
        },
      }),
    );

    const result = await service.handleWebhook({
      alert_id: "alert-1",
      event_type: "arrival",
      event_time: "2030-01-01T10:00:00.000Z",
      flight: {
        ident: "BA74",
        fa_flight_id: "fa-1",
        origin: { code: "EGLL" },
        destination: { code: "DNMM" },
      },
    });

    expect(result).toEqual({
      duplicate: true,
      flightId: "flight-1",
      bookingCount: 1,
      newStatus: FlightStatus.SCHEDULED,
    });
  });

  it("updates flight and creates status event for new webhook event", async () => {
    const updateFlightMock = vi.fn().mockResolvedValue({ status: FlightStatus.LANDED });
    vi.mocked(databaseService.flight.findFirst).mockResolvedValueOnce({
      id: "flight-2",
      status: FlightStatus.SCHEDULED,
    });
    vi.mocked(databaseService.booking.count).mockResolvedValueOnce(3);
    vi.mocked(databaseService.$transaction).mockImplementationOnce(async (callback) =>
      callback({
        flight: {
          update: updateFlightMock,
        },
        flightStatusEvent: {
          create: vi.fn().mockResolvedValue({ id: "event-2" }),
          update: vi.fn().mockResolvedValue({ id: "event-2" }),
        },
      }),
    );

    const result = await service.handleWebhook({
      alert_id: "alert-2",
      event_type: "arrival",
      event_time: "2030-01-01T10:00:00.000Z",
      flight: {
        ident: "BA75",
        fa_flight_id: "fa-2",
        estimated_in: "2030-01-01T10:20:00.000Z",
        actual_in: "2030-01-01T10:15:00.000Z",
        delay_minutes: 5,
        gate_destination: "G2",
        origin: { code: "EGLL" },
        destination: { code: "DNMM" },
      },
    });

    expect(result).toEqual({
      duplicate: false,
      flightId: "flight-2",
      bookingCount: 3,
      newStatus: FlightStatus.LANDED,
    });
    expect(updateFlightMock).toHaveBeenCalledWith({
      where: { id: "flight-2" },
      data: {
        status: FlightStatus.LANDED,
        estimatedDeparture: undefined,
        estimatedArrival: new Date("2030-01-01T10:20:00.000Z"),
        actualDeparture: undefined,
        actualArrival: new Date("2030-01-01T10:15:00.000Z"),
        delayMinutes: 5,
        arrivalGate: "G2",
        departureGate: undefined,
        aircraftType: undefined,
        registration: undefined,
      },
    });
  });

  it("updates flight with same mapping in unique-conflict recovery path", async () => {
    const updateFlightMock = vi.fn().mockResolvedValue({ status: FlightStatus.LANDED });
    vi.mocked(databaseService.flight.findFirst).mockResolvedValueOnce({
      id: "flight-3",
      status: FlightStatus.SCHEDULED,
    });
    vi.mocked(databaseService.booking.count).mockResolvedValueOnce(2);
    vi.mocked(databaseService.$transaction).mockImplementationOnce(async (callback) =>
      callback({
        flight: {
          update: updateFlightMock,
        },
        flightStatusEvent: {
          create: vi.fn().mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError("Unique violation", {
              code: "P2002",
              clientVersion: "test",
            }),
          ),
          findFirst: vi.fn().mockResolvedValue({
            id: "event-3",
            processed: false,
            newStatus: FlightStatus.SCHEDULED,
          }),
          update: vi.fn().mockResolvedValue({ id: "event-3" }),
        },
      }),
    );

    const result = await service.handleWebhook({
      alert_id: "alert-3",
      event_type: "arrival",
      event_time: "2030-01-01T11:00:00.000Z",
      flight: {
        ident: "BA76",
        fa_flight_id: "fa-3",
        estimated_off: "2030-01-01T09:00:00.000Z",
        estimated_in: "2030-01-01T11:20:00.000Z",
        actual_off: "2030-01-01T09:10:00.000Z",
        actual_in: "2030-01-01T11:15:00.000Z",
        delay_minutes: 10,
        gate_origin: "A1",
        gate_destination: "B2",
        aircraft_type: "B77W",
        registration: "G-ABCD",
        origin: { code: "EGLL" },
        destination: { code: "DNMM" },
      },
    });

    expect(result).toEqual({
      duplicate: false,
      flightId: "flight-3",
      bookingCount: 2,
      newStatus: FlightStatus.LANDED,
    });
    expect(updateFlightMock).toHaveBeenCalledWith({
      where: { id: "flight-3" },
      data: {
        status: FlightStatus.LANDED,
        estimatedDeparture: new Date("2030-01-01T09:00:00.000Z"),
        estimatedArrival: new Date("2030-01-01T11:20:00.000Z"),
        actualDeparture: new Date("2030-01-01T09:10:00.000Z"),
        actualArrival: new Date("2030-01-01T11:15:00.000Z"),
        delayMinutes: 10,
        arrivalGate: "B2",
        departureGate: "A1",
        aircraftType: "B77W",
        registration: "G-ABCD",
      },
    });
  });

  it("emits flight arrival updated event when activation time is resolved", async () => {
    vi.mocked(databaseService.flight.findFirst).mockResolvedValueOnce({
      id: "flight-4",
      status: FlightStatus.SCHEDULED,
    });
    vi.mocked(databaseService.booking.count).mockResolvedValueOnce(1);
    vi.mocked(databaseService.$transaction).mockImplementationOnce(async (callback) =>
      callback({
        flight: {
          update: vi.fn(),
        },
        flightStatusEvent: {
          create: vi.fn().mockResolvedValue({ id: "event-4" }),
          update: vi.fn().mockResolvedValue({ id: "event-4" }),
        },
      }),
    );

    await service.handleWebhook({
      alert_id: "alert-4",
      event_type: "arrival",
      event_time: "2030-01-01T10:00:00.000Z",
      flight: {
        ident: "BA77",
        fa_flight_id: "fa-4",
        estimated_in: "2030-01-01T11:00:00.000Z",
        origin: { code: "EGLL" },
        destination: { code: "DNMM" },
      },
    });

    expect(eventEmitter.emit).toHaveBeenCalledWith(FLIGHT_ARRIVAL_UPDATED_EVENT, {
      flightId: "flight-4",
      activationAt: "2030-01-01T11:40:00.000Z",
    });
  });

  it("emits flight arrival updated when earlier arrival fields are empty strings and a later field is valid", async () => {
    vi.mocked(databaseService.flight.findFirst).mockResolvedValueOnce({
      id: "flight-empty-strings",
      status: FlightStatus.SCHEDULED,
    });
    vi.mocked(databaseService.booking.count).mockResolvedValueOnce(1);
    vi.mocked(databaseService.$transaction).mockImplementationOnce(async (callback) =>
      callback({
        flight: {
          update: vi.fn(),
        },
        flightStatusEvent: {
          create: vi.fn().mockResolvedValue({ id: "event-empty" }),
          update: vi.fn().mockResolvedValue({ id: "event-empty" }),
        },
      }),
    );

    await service.handleWebhook({
      alert_id: "alert-empty-strings",
      event_type: "arrival",
      event_time: "2030-01-01T10:00:00.000Z",
      flight: {
        ident: "BA83",
        fa_flight_id: "fa-empty",
        actual_in: "",
        actual_on: "",
        estimated_in: "2030-01-01T11:00:00.000Z",
        origin: { code: "EGLL" },
        destination: { code: "DNMM" },
      },
    });

    expect(eventEmitter.emit).toHaveBeenCalledWith(FLIGHT_ARRIVAL_UPDATED_EVENT, {
      flightId: "flight-empty-strings",
      activationAt: "2030-01-01T11:40:00.000Z",
    });
  });

  it("does not fail webhook processing if flight arrival event emission fails", async () => {
    vi.mocked(databaseService.flight.findFirst).mockResolvedValueOnce({
      id: "flight-event-failure",
      status: FlightStatus.SCHEDULED,
    });
    vi.mocked(databaseService.booking.count).mockResolvedValueOnce(1);
    vi.mocked(databaseService.$transaction).mockImplementationOnce(async (callback) =>
      callback({
        flight: {
          update: vi.fn(),
        },
        flightStatusEvent: {
          create: vi.fn().mockResolvedValue({ id: "event-failure" }),
          update: vi.fn().mockResolvedValue({ id: "event-failure" }),
        },
      }),
    );
    vi.mocked(eventEmitterReadinessWatcher.waitUntilReady).mockRejectedValueOnce(
      new Error("Event emitter not ready"),
    );

    const result = await service.handleWebhook({
      alert_id: "alert-event-failure",
      event_type: "arrival",
      event_time: "2030-01-01T10:00:00.000Z",
      flight: {
        ident: "BA79",
        fa_flight_id: "fa-event-failure",
        estimated_in: "2030-01-01T11:00:00.000Z",
        origin: { code: "EGLL" },
        destination: { code: "DNMM" },
      },
    });

    expect(result).toEqual({
      duplicate: false,
      flightId: "flight-event-failure",
      bookingCount: 1,
      newStatus: FlightStatus.LANDED,
    });
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it("does not fail webhook processing if flight arrival emit throws synchronously", async () => {
    vi.mocked(databaseService.flight.findFirst).mockResolvedValueOnce({
      id: "flight-emit-throw",
      status: FlightStatus.SCHEDULED,
    });
    vi.mocked(databaseService.booking.count).mockResolvedValueOnce(1);
    vi.mocked(databaseService.$transaction).mockImplementationOnce(async (callback) =>
      callback({
        flight: {
          update: vi.fn(),
        },
        flightStatusEvent: {
          create: vi.fn().mockResolvedValue({ id: "event-emit-throw" }),
          update: vi.fn().mockResolvedValue({ id: "event-emit-throw" }),
        },
      }),
    );
    vi.mocked(eventEmitter.emit).mockImplementationOnce(() => {
      throw new Error("emit failed");
    });

    const result = await service.handleWebhook({
      alert_id: "alert-emit-throw",
      event_type: "arrival",
      event_time: "2030-01-01T10:00:00.000Z",
      flight: {
        ident: "BA82",
        fa_flight_id: "fa-emit-throw",
        estimated_in: "2030-01-01T11:00:00.000Z",
        origin: { code: "EGLL" },
        destination: { code: "DNMM" },
      },
    });

    expect(result).toEqual({
      duplicate: false,
      flightId: "flight-emit-throw",
      bookingCount: 1,
      newStatus: FlightStatus.LANDED,
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith(FLIGHT_ARRIVAL_UPDATED_EVENT, {
      flightId: "flight-emit-throw",
      activationAt: "2030-01-01T11:40:00.000Z",
    });
  });

  it("does not emit flight arrival updated event when activation time cannot be resolved", async () => {
    vi.mocked(databaseService.flight.findFirst).mockResolvedValueOnce({
      id: "flight-5",
      status: FlightStatus.SCHEDULED,
    });
    vi.mocked(databaseService.booking.count).mockResolvedValueOnce(1);
    vi.mocked(databaseService.$transaction).mockImplementationOnce(async (callback) =>
      callback({
        flight: {
          update: vi.fn(),
        },
        flightStatusEvent: {
          create: vi.fn().mockResolvedValue({ id: "event-5" }),
          update: vi.fn().mockResolvedValue({ id: "event-5" }),
        },
      }),
    );

    await service.handleWebhook({
      alert_id: "alert-5",
      event_type: "arrival",
      event_time: "2030-01-01T10:00:00.000Z",
      flight: {
        ident: "BA78",
        fa_flight_id: "fa-5",
        estimated_in: "not-a-date",
        origin: { code: "EGLL" },
        destination: { code: "DNMM" },
      },
    });

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "cancelled",
      event_type: "cancelled",
      alert_id: "alert-cancelled",
      flightId: "flight-cancelled",
      ident: "BA80",
      fa_flight_id: "fa-cancelled",
      statusEventId: "event-cancelled",
    },
    {
      label: "diverted",
      event_type: "diverted",
      alert_id: "alert-diverted",
      flightId: "flight-diverted",
      ident: "BA81",
      fa_flight_id: "fa-diverted",
      statusEventId: "event-diverted",
    },
  ])(
    "does not emit flight arrival updated event for $label flights",
    async ({ event_type, alert_id, flightId, ident, fa_flight_id, statusEventId }) => {
      vi.mocked(databaseService.flight.findFirst).mockResolvedValueOnce({
        id: flightId,
        status: FlightStatus.SCHEDULED,
      });
      vi.mocked(databaseService.booking.count).mockResolvedValueOnce(1);
      vi.mocked(databaseService.$transaction).mockImplementationOnce(async (callback) =>
        callback({
          flight: {
            update: vi.fn(),
          },
          flightStatusEvent: {
            create: vi.fn().mockResolvedValue({ id: statusEventId }),
            update: vi.fn().mockResolvedValue({ id: statusEventId }),
          },
        }),
      );

      await service.handleWebhook({
        alert_id,
        event_type,
        event_time: "2030-01-01T10:00:00.000Z",
        flight: {
          ident,
          fa_flight_id,
          estimated_in: "2030-01-01T11:00:00.000Z",
          origin: { code: "EGLL" },
          destination: { code: "DNMM" },
        },
      });

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    },
  );
});
