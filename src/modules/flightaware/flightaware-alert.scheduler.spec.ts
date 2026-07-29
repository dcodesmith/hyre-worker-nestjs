import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, BookingType, PaymentStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { CREATE_FLIGHT_ALERT_JOB, FLIGHT_ALERTS_QUEUE } from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import { FlightAwareAlertScheduler } from "./flightaware-alert.scheduler";

describe("FlightAwareAlertScheduler", () => {
  let scheduler: FlightAwareAlertScheduler;
  let databaseService: { flight: { findMany: ReturnType<typeof vi.fn> } };
  let queue: { add: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-02T12:02:00.000Z"));
    databaseService = {
      flight: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "flight-1",
            flightNumber: "BA74",
            scheduledDeparture: new Date("2030-01-02T08:00:00.000Z"),
            originCode: "EGLL",
            originTimezone: "Europe/London",
            destinationCodeIATA: "LOS",
          },
        ]),
      },
    };
    queue = { add: vi.fn().mockResolvedValue({ id: "job-1" }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightAwareAlertScheduler,
        { provide: DatabaseService, useValue: databaseService },
        { provide: getQueueToken(FLIGHT_ALERTS_QUEUE), useValue: queue },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    scheduler = module.get(FlightAwareAlertScheduler);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requeues active-booking flights that are missing an alert", async () => {
    await scheduler.reconcileMissingAlerts();

    expect(databaseService.flight.findMany).toHaveBeenCalledWith({
      where: {
        alertEnabled: false,
        scheduledDeparture: {
          gte: new Date("2029-12-31T12:02:00.000Z"),
        },
        bookings: {
          some: {
            deletedAt: null,
            type: BookingType.AIRPORT_PICKUP,
            paymentStatus: PaymentStatus.PAID,
            status: {
              in: [BookingStatus.CONFIRMED, BookingStatus.ACTIVE],
            },
          },
        },
      },
      select: {
        id: true,
        flightNumber: true,
        scheduledDeparture: true,
        originCode: true,
        originTimezone: true,
        destinationCodeIATA: true,
      },
      orderBy: { scheduledDeparture: "asc" },
      take: 100,
    });
    expect(queue.add).toHaveBeenCalledWith(
      CREATE_FLIGHT_ALERT_JOB,
      {
        flightId: "flight-1",
        flightNumber: "BA74",
        departureTime: "2030-01-02T08:00:00.000Z",
        originCode: "EGLL",
        originTimezone: "Europe/London",
        destinationIATA: "LOS",
      },
      {
        jobId: "flight-alert-reconcile-flight-1-6311952",
      },
    );
  });
});
