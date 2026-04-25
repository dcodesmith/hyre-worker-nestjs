import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { STATUS_UPDATES_QUEUE } from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import { StatusChangeSchedulingService } from "./status-change-scheduling.service";

describe("StatusChangeSchedulingService", () => {
  let service: StatusChangeSchedulingService;
  let databaseService: {
    booking: {
      findMany: Mock<() => Promise<Array<{ id: string }>>>;
    };
  };
  let statusUpdateQueue: {
    add: Mock;
    getJob: Mock;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusChangeSchedulingService,
        {
          provide: DatabaseService,
          useValue: {
            booking: {
              findMany: vi.fn(),
            },
          },
        },
        {
          provide: getQueueToken(STATUS_UPDATES_QUEUE),
          useValue: {
            add: vi.fn(),
            getJob: vi.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<StatusChangeSchedulingService>(StatusChangeSchedulingService);
    databaseService = module.get(DatabaseService);
    statusUpdateQueue = module.get(getQueueToken(STATUS_UPDATES_QUEUE));
  });

  it("schedules airport activation with deterministic jobId", async () => {
    const activationAt = new Date(Date.now() + 60_000);

    await service.scheduleAirportActivation("booking-1", activationAt);

    expect(statusUpdateQueue.add).toHaveBeenCalledWith(
      "activate-airport-booking",
      {
        type: "activate-airport-booking",
        bookingId: "booking-1",
        activationAt: activationAt.toISOString(),
      },
      expect.objectContaining({
        jobId: "activate-airport-booking-booking-1",
      }),
    );
  });

  it("reschedules airport activation when existing job is present", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    vi.mocked(statusUpdateQueue.getJob).mockResolvedValueOnce({ remove });
    const activationAt = new Date(Date.now() + 60_000);

    await service.scheduleAirportActivation("booking-2", activationAt);

    expect(remove).toHaveBeenCalledOnce();
    expect(statusUpdateQueue.add).toHaveBeenCalledOnce();
  });

  it("schedules activations for all eligible bookings on a flight", async () => {
    databaseService.booking.findMany.mockResolvedValueOnce([
      { id: "booking-a" },
      { id: "booking-b" },
    ]);
    const activationAt = new Date(Date.now() + 60_000);

    await service.scheduleAirportActivationsForFlight("flight-1", activationAt);

    expect(databaseService.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          flightId: "flight-1",
        }),
      }),
    );
    expect(statusUpdateQueue.add).toHaveBeenCalledTimes(2);
  });
});
