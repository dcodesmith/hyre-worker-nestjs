import { EventEmitter2, EventEmitterReadinessWatcher } from "@nestjs/event-emitter";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, FlightStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { FLIGHT_ARRIVAL_UPDATED_EVENT } from "../../shared/events/airport-activation.events";
import { DatabaseService } from "../database/database.service";
import { FlightStatusUpdatedHandler } from "../notification/handlers/flight-status-updated.handler";
import { NotificationType } from "../notification/notification.interface";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import type { FlightAwareWebhookDto } from "./dto/flightaware-webhook.dto";
import { FlightAwareWebhookService } from "./flightaware-webhook.service";

type TransactionClient = {
  $executeRaw: ReturnType<typeof vi.fn>;
  flight: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  flightStatusEvent: {
    createMany: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  booking: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
};

const flightRecord = {
  id: "flight-1",
  flightNumber: "BA74",
  destinationCode: "DNMM",
  destinationCodeIATA: "LOS",
  status: FlightStatus.SCHEDULED,
  delayMinutes: null,
  arrivalGate: null,
  arrivalTerminal: null,
  scheduledArrival: new Date("2030-01-01T10:00:00.000Z"),
  estimatedArrival: null,
  actualArrival: null,
};

function createPayload(
  overrides: Partial<Omit<FlightAwareWebhookDto, "flight">> & {
    flight?: Partial<FlightAwareWebhookDto["flight"]>;
  } = {},
): FlightAwareWebhookDto {
  return {
    alert_id: 123,
    event_code: "arrival",
    long_description: "British Airways 74 has arrived.",
    short_description: "BA74 arrived",
    summary: "Arrival",
    ...overrides,
    flight: {
      fa_flight_id: "BAW74-20300101",
      ident: "BA74",
      origin: "EGLL",
      origin_iata: "LHR",
      destination: "DNMM",
      destination_iata: "LOS",
      scheduled_in: "2030-01-01T10:00:00.000Z",
      estimated_in: "2030-01-01T10:00:00.000Z",
      ...overrides.flight,
    },
  };
}

describe("FlightAwareWebhookService", () => {
  let service: FlightAwareWebhookService;
  let databaseService: {
    flight: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let notificationOutboxService: {
    create: ReturnType<typeof vi.fn>;
  };
  let flightStatusUpdatedHandler: FlightStatusUpdatedHandler;
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let transactionClient: TransactionClient;
  const handleWebhook = (payload: FlightAwareWebhookDto) =>
    service.handleWebhook(payload, flightRecord.id);

  beforeEach(async () => {
    transactionClient = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      flight: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(flightRecord),
        update: vi.fn(),
      },
      flightStatusEvent: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "status-event-1",
          processed: false,
        }),
        update: vi.fn(),
      },
      booking: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "booking-1",
            userId: "customer-1",
            status: BookingStatus.CONFIRMED,
          },
        ]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightAwareWebhookService,
        {
          provide: DatabaseService,
          useValue: {
            flight: {
              findFirst: vi.fn().mockResolvedValue(flightRecord),
            },
            $transaction: vi.fn((callback: (tx: TransactionClient) => Promise<unknown>) =>
              callback(transactionClient),
            ),
          },
        },
        {
          provide: NotificationOutboxService,
          useValue: {
            create: vi.fn(
              async (
                _handler: FlightStatusUpdatedHandler,
                input: {
                  bookings: unknown[];
                  notifications: unknown[];
                },
              ) => input.bookings.length * input.notifications.length,
            ),
          },
        },
        {
          provide: FlightStatusUpdatedHandler,
          useValue: {},
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
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(FlightAwareWebhookService);
    databaseService = module.get(DatabaseService);
    notificationOutboxService = module.get(NotificationOutboxService);
    flightStatusUpdatedHandler = module.get(FlightStatusUpdatedHandler);
    eventEmitter = module.get(EventEmitter2);
  });

  it("persists an official arrival callback and creates a durable operational notification", async () => {
    const result = await handleWebhook(
      createPayload({
        flight: {
          estimated_in: "2030-01-01T10:05:00.000Z",
          actual_in: "2030-01-01T10:05:00.000Z",
          gate_destination: "G2",
        },
      }),
    );

    expect(databaseService.flight.findFirst).toHaveBeenCalledWith({
      where: {
        id: "flight-1",
        alertId: "123",
        alertEnabled: true,
      },
      select: {
        id: true,
      },
    });
    expect(transactionClient.$executeRaw).toHaveBeenCalledTimes(1);
    expect(transactionClient.flightStatusEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          eventKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          flightId: "flight-1",
          eventType: "arrival",
          oldStatus: FlightStatus.SCHEDULED,
          newStatus: FlightStatus.LANDED,
          delayChange: 5,
        }),
      ],
      skipDuplicates: true,
    });
    expect(transactionClient.flight.update).toHaveBeenCalledWith({
      where: { id: "flight-1" },
      data: expect.objectContaining({
        status: FlightStatus.LANDED,
        estimatedArrival: new Date("2030-01-01T10:05:00.000Z"),
        actualArrival: new Date("2030-01-01T10:05:00.000Z"),
        delayMinutes: 5,
        arrivalGate: "G2",
        isLive: true,
      }),
    });
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({
        statusEventId: "status-event-1",
        flightId: "flight-1",
        flightNumber: "BA74",
        arrivalLocation: "LOS, Gate G2",
        bookings: [expect.objectContaining({ id: "booking-1" })],
        notifications: [
          {
            type: NotificationType.FLIGHT_ARRIVED,
            operationalTitle: "Pickup flight arrived",
            operationalBody: "BA74 has arrived at LOS at gate G2. Prepare for the customer pickup.",
          },
        ],
      }),
      transactionClient,
    );
    expect(eventEmitter.emit).toHaveBeenCalledWith(FLIGHT_ARRIVAL_UPDATED_EVENT, {
      flightId: "flight-1",
      activationAt: "2030-01-01T10:45:00.000Z",
    });
    expect(result).toEqual({
      duplicate: false,
      flightId: "flight-1",
      bookingCount: 1,
      newStatus: FlightStatus.LANDED,
    });
  });

  it("creates separate durable delay and arrival-gate notifications from a change callback", async () => {
    transactionClient.flight.findUniqueOrThrow.mockResolvedValueOnce({
      ...flightRecord,
      status: FlightStatus.EN_ROUTE,
      delayMinutes: 10,
      arrivalGate: "G1",
    });

    const result = await handleWebhook(
      createPayload({
        event_code: "change",
        flight: {
          estimated_in: "2030-01-01T10:45:00.000Z",
          gate_destination: "G2",
        },
      }),
    );

    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({
        notifications: [
          {
            type: NotificationType.FLIGHT_DELAYED,
            operationalTitle: "Pickup flight delay updated",
            operationalBody: "BA74 is delayed by 45 minutes. Pickup timing has been recalculated.",
            customerTitle: "Your pickup flight timing changed",
            customerBody:
              "BA74 is delayed by 45 minutes. We are tracking it and have adjusted your pickup timing.",
          },
          {
            type: NotificationType.FLIGHT_GATE_CHANGED,
            operationalTitle: "Pickup flight arrival gate updated",
            operationalBody: "BA74 will arrive at gate G2.",
          },
        ],
      }),
      transactionClient,
    );
    expect(result.newStatus).toBe(FlightStatus.EN_ROUTE);
  });

  it("does not notify customers for sub-threshold arrival delays", async () => {
    transactionClient.flight.findUniqueOrThrow.mockResolvedValueOnce({
      ...flightRecord,
      status: FlightStatus.EN_ROUTE,
    });

    await handleWebhook(
      createPayload({
        event_code: "change",
        flight: { estimated_in: "2030-01-01T10:05:00.000Z" },
      }),
    );

    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({ notifications: [] }),
      transactionClient,
    );
  });

  it("notifies operations, but not the customer, for a 15-minute delay", async () => {
    transactionClient.flight.findUniqueOrThrow.mockResolvedValueOnce({
      ...flightRecord,
      status: FlightStatus.EN_ROUTE,
      delayMinutes: 0,
    });

    await handleWebhook(
      createPayload({
        event_code: "change",
        flight: { estimated_in: "2030-01-01T10:15:00.000Z" },
      }),
    );

    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({
        notifications: [
          expect.objectContaining({
            type: NotificationType.FLIGHT_DELAYED,
            customerTitle: undefined,
            customerBody: undefined,
          }),
        ],
      }),
      transactionClient,
    );
  });

  it("notifies operations for arrival ETA movement without treating it as customer impact", async () => {
    transactionClient.flight.findUniqueOrThrow.mockResolvedValueOnce({
      ...flightRecord,
      status: FlightStatus.SCHEDULED,
      delayMinutes: 0,
    });

    await handleWebhook(
      createPayload({
        event_code: "change",
        flight: { estimated_in: "2030-01-01T10:20:00.000Z" },
      }),
    );

    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({
        notifications: [
          expect.objectContaining({
            type: NotificationType.FLIGHT_DELAYED,
            operationalBody: "BA74 is delayed by 20 minutes. Pickup timing has been recalculated.",
            customerTitle: undefined,
          }),
        ],
      }),
      transactionClient,
    );
  });

  it("notifies operations and the customer when a material delay clears", async () => {
    transactionClient.flight.findUniqueOrThrow.mockResolvedValueOnce({
      ...flightRecord,
      status: FlightStatus.EN_ROUTE,
      delayMinutes: 45,
    });

    await handleWebhook(
      createPayload({
        event_code: "change",
        flight: { estimated_in: "2030-01-01T09:48:00.000Z" },
      }),
    );

    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({
        notifications: [
          expect.objectContaining({
            type: NotificationType.FLIGHT_DELAY_RECOVERED,
            operationalBody:
              "BA74's reported delay is now 0 minutes. Pickup timing has been recalculated.",
            customerTitle: "Your pickup flight delay improved",
            customerBody:
              "BA74's reported delay is now 0 minutes. We have updated your pickup timing.",
          }),
        ],
      }),
      transactionClient,
    );
  });

  it("persists and notifies an arrival-terminal change for operations", async () => {
    transactionClient.flight.findUniqueOrThrow.mockResolvedValueOnce({
      ...flightRecord,
      status: FlightStatus.EN_ROUTE,
      arrivalTerminal: "1",
    });

    await handleWebhook(
      createPayload({
        event_code: "change",
        flight: { terminal_destination: "2" },
      }),
    );

    expect(transactionClient.flight.update).toHaveBeenCalledWith({
      where: { id: "flight-1" },
      data: expect.objectContaining({ arrivalTerminal: "2" }),
    });
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({
        arrivalLocation: "LOS, Terminal 2",
        notifications: [
          {
            type: NotificationType.FLIGHT_TERMINAL_CHANGED,
            operationalTitle: "Pickup flight terminal updated",
            operationalBody: "BA74 will arrive at terminal 2.",
          },
        ],
      }),
      transactionClient,
    );
  });

  it("clears a removed gate and delay and notifies the gate removal", async () => {
    transactionClient.flight.findUniqueOrThrow.mockResolvedValueOnce({
      ...flightRecord,
      status: FlightStatus.EN_ROUTE,
      delayMinutes: 45,
      arrivalGate: "G2",
    });

    await handleWebhook(
      createPayload({
        event_code: "change",
        flight: {
          estimated_in: undefined,
          gate_destination: null,
        },
      }),
    );

    expect(transactionClient.flight.update).toHaveBeenCalledWith({
      where: { id: "flight-1" },
      data: expect.objectContaining({
        delayMinutes: null,
        arrivalGate: null,
      }),
    });
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({
        notifications: [
          {
            type: NotificationType.FLIGHT_GATE_CHANGED,
            operationalTitle: "Arrival gate removed",
            operationalBody:
              "BA74's arrival gate is no longer assigned. Check FlightAware before pickup.",
          },
        ],
      }),
      transactionClient,
    );
  });

  it("does not repeat cancellation for a change callback with a persistent cancelled flag", async () => {
    transactionClient.flight.findUniqueOrThrow.mockResolvedValueOnce({
      ...flightRecord,
      status: FlightStatus.CANCELLED,
    });

    const result = await handleWebhook(
      createPayload({
        event_code: "change",
        flight: { cancelled: true },
      }),
    );

    expect(result.newStatus).toBe(FlightStatus.CANCELLED);
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({ notifications: [] }),
      transactionClient,
    );
  });

  it("does not repeat an explicit cancellation callback after the flight is cancelled", async () => {
    transactionClient.flight.findUniqueOrThrow.mockResolvedValueOnce({
      ...flightRecord,
      status: FlightStatus.CANCELLED,
    });

    await handleWebhook(
      createPayload({
        event_code: "cancelled",
        flight: {
          cancelled: true,
          gate_destination: "G3",
        },
      }),
    );

    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({ notifications: [] }),
      transactionClient,
    );
  });

  it("restores a cancelled flight when a change callback clears cancellation", async () => {
    transactionClient.flight.findUniqueOrThrow.mockResolvedValueOnce({
      ...flightRecord,
      status: FlightStatus.CANCELLED,
    });

    const result = await handleWebhook(
      createPayload({
        event_code: "change",
        flight: { cancelled: false },
      }),
    );

    expect(result.newStatus).toBe(FlightStatus.SCHEDULED);
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({
        notifications: [
          expect.objectContaining({
            type: NotificationType.FLIGHT_REINSTATED,
            customerTitle: "Your pickup flight is operating again",
          }),
        ],
      }),
      transactionClient,
    );
  });

  it("does not regress a landed flight for a late filed callback", async () => {
    transactionClient.flight.findUniqueOrThrow.mockResolvedValueOnce({
      ...flightRecord,
      status: FlightStatus.LANDED,
    });

    const result = await handleWebhook(createPayload({ event_code: "filed" }));

    expect(result.newStatus).toBe(FlightStatus.LANDED);
  });

  it("does not classify a position-only arrival as an authoritative landing", async () => {
    const result = await handleWebhook(createPayload({ event_code: "position_only_arrival" }));

    expect(result.newStatus).toBe(FlightStatus.SCHEDULED);
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({ notifications: [] }),
      transactionClient,
    );
  });

  it.each([
    {
      eventCode: "cancelled" as const,
      expectedStatus: FlightStatus.CANCELLED,
      expectedType: NotificationType.FLIGHT_CANCELLED,
    },
    {
      eventCode: "diverted" as const,
      expectedStatus: FlightStatus.DIVERTED,
      expectedType: NotificationType.FLIGHT_DIVERTED,
    },
  ])(
    "creates a durable $eventCode notification",
    async ({ eventCode, expectedStatus, expectedType }) => {
      const result = await handleWebhook(
        createPayload({
          event_code: eventCode,
          flight: {
            cancelled: eventCode === "cancelled",
            diverted: eventCode === "diverted",
          },
        }),
      );

      expect(notificationOutboxService.create).toHaveBeenCalledWith(
        flightStatusUpdatedHandler,
        expect.objectContaining({
          notifications: [expect.objectContaining({ type: expectedType })],
        }),
        transactionClient,
      );
      expect(result.newStatus).toBe(expectedStatus);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    },
  );

  it("updates departure status and notifies operations without a customer message", async () => {
    const result = await handleWebhook(createPayload({ event_code: "departure" }));

    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({
        notifications: [
          {
            type: NotificationType.FLIGHT_DEPARTED,
            operationalTitle: "Pickup flight departed",
            operationalBody:
              "BA74 has departed. Monitor its expected arrival and pickup activation time.",
          },
        ],
      }),
      transactionClient,
    );
    expect(result.newStatus).toBe(FlightStatus.DEPARTED);
    expect(transactionClient.flightStatusEvent.update).toHaveBeenCalledWith({
      where: { id: "status-event-1" },
      data: expect.objectContaining({
        processed: true,
      }),
    });
  });

  it("keeps registered and guest bookings returned by the eligibility query", async () => {
    transactionClient.booking.findMany.mockResolvedValueOnce([
      { id: "confirmed", userId: "customer-1", status: BookingStatus.CONFIRMED },
      { id: "guest", userId: null, status: BookingStatus.CONFIRMED },
    ]);

    const result = await handleWebhook(createPayload());

    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      flightStatusUpdatedHandler,
      expect.objectContaining({
        bookings: [
          { id: "confirmed", userId: "customer-1", status: BookingStatus.CONFIRMED },
          { id: "guest", userId: null, status: BookingStatus.CONFIRMED },
        ],
      }),
      transactionClient,
    );
    expect(transactionClient.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.ACTIVE] },
        }),
      }),
    );
    expect(result.bookingCount).toBe(2);
  });

  it("returns duplicate without repeating updates, notifications, or activation", async () => {
    transactionClient.flightStatusEvent.createMany.mockResolvedValueOnce({ count: 0 });
    transactionClient.flightStatusEvent.findUniqueOrThrow.mockResolvedValueOnce({
      id: "status-event-existing",
      processed: true,
    });
    transactionClient.flight.findUniqueOrThrow.mockResolvedValueOnce({
      ...flightRecord,
      status: FlightStatus.LANDED,
    });

    const result = await handleWebhook(createPayload());

    expect(transactionClient.flight.update).not.toHaveBeenCalled();
    expect(notificationOutboxService.create).not.toHaveBeenCalled();
    expect(transactionClient.booking.findMany).not.toHaveBeenCalled();
    expect(transactionClient.booking.count).toHaveBeenCalledOnce();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(result).toEqual({
      duplicate: true,
      flightId: "flight-1",
      bookingCount: 1,
      newStatus: FlightStatus.LANDED,
    });
  });

  it("recovers an unprocessed event using the same deterministic event key", async () => {
    transactionClient.flightStatusEvent.createMany.mockResolvedValueOnce({ count: 0 });
    transactionClient.flightStatusEvent.findUniqueOrThrow.mockResolvedValueOnce({
      id: "status-event-pending",
      processed: false,
    });

    await handleWebhook(createPayload());

    expect(transactionClient.flight.update).toHaveBeenCalledOnce();
    expect(notificationOutboxService.create).toHaveBeenCalledOnce();
    expect(transactionClient.flightStatusEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "status-event-pending" },
      }),
    );
  });

  it("fails the transaction when durable notification creation fails", async () => {
    notificationOutboxService.create.mockRejectedValueOnce(
      new Error("flight notification outbox failed"),
    );

    await expect(handleWebhook(createPayload())).rejects.toThrow(
      "flight notification outbox failed",
    );
  });

  it("rejects callbacks for unknown alert IDs", async () => {
    vi.mocked(databaseService.flight.findFirst).mockResolvedValueOnce(null);

    await expect(handleWebhook(createPayload())).rejects.toThrow("Flight not found");
    expect(databaseService.$transaction).not.toHaveBeenCalled();
  });
});
