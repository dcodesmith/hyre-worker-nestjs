import { getQueueToken } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_TO_COMPLETED,
  BOOKING_LEG_END_REMINDER,
  BOOKING_LEG_START_REMINDER,
  CONFIRMED_TO_ACTIVE,
  REMINDERS_QUEUE,
  STATUS_UPDATES_QUEUE,
  TRIP_END,
  TRIP_START,
} from "../../config/constants";
import { JobEnqueueFailedException } from "./errors";
import { JobService } from "./job.service";

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "12345678-aaaa-bbbb-cccc-dddddddddddd"),
}));

describe("JobService", () => {
  let service: JobService;
  let reminderQueue: Queue;
  let statusUpdateQueue: Queue;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-02T03:04:05.000Z"));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobService,
        {
          provide: getQueueToken(REMINDERS_QUEUE),
          useValue: {
            add: vi.fn().mockResolvedValue({ id: "job-1" }),
          },
        },
        {
          provide: getQueueToken(STATUS_UPDATES_QUEUE),
          useValue: {
            add: vi.fn().mockResolvedValue({ id: "job-2" }),
          },
        },
      ],
    }).compile();

    service = module.get<JobService>(JobService);
    reminderQueue = module.get<Queue>(getQueueToken(REMINDERS_QUEUE));
    statusUpdateQueue = module.get<Queue>(getQueueToken(STATUS_UPDATES_QUEUE));

    // Suppress logger noise for expected error-path tests
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("should enqueue start booking leg reminders", async () => {
    await service.triggerStartBookingLegReminders();

    expect(reminderQueue.add).toHaveBeenCalledWith(
      BOOKING_LEG_START_REMINDER,
      {
        type: TRIP_START,
        timestamp: "2025-01-02T03:04:05.000Z",
      },
      {
        jobId: "booking-leg-start-reminder-2025-01-02T03:04:05.000Z-12345678",
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      },
    );
  });

  it("should enqueue end booking leg reminders", async () => {
    await service.triggerBookingLegEndReminders();

    expect(reminderQueue.add).toHaveBeenCalledWith(
      BOOKING_LEG_END_REMINDER,
      {
        type: TRIP_END,
        timestamp: "2025-01-02T03:04:05.000Z",
      },
      {
        jobId: "booking-leg-end-reminder-2025-01-02T03:04:05.000Z-12345678",
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      },
    );
  });

  it("should enqueue confirmed to active status updates", async () => {
    await service.triggerActivateBookings();

    expect(statusUpdateQueue.add).toHaveBeenCalledWith(
      CONFIRMED_TO_ACTIVE,
      {
        type: CONFIRMED_TO_ACTIVE,
        timestamp: "2025-01-02T03:04:05.000Z",
      },
      {
        jobId: "confirmed-to-active-2025-01-02T03:04:05.000Z-12345678",
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      },
    );
  });

  it("should enqueue active to completed status updates", async () => {
    await service.triggerCompleteBookings();

    expect(statusUpdateQueue.add).toHaveBeenCalledWith(
      ACTIVE_TO_COMPLETED,
      {
        type: ACTIVE_TO_COMPLETED,
        timestamp: "2025-01-02T03:04:05.000Z",
      },
      {
        jobId: "active-to-completed-2025-01-02T03:04:05.000Z-12345678",
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      },
    );
  });

  it("should throw JobEnqueueFailedException when enqueue fails", async () => {
    const error = new Error("Queue error");
    vi.mocked(reminderQueue.add).mockRejectedValueOnce(error);

    await expect(service.triggerStartBookingLegReminders()).rejects.toThrow(
      JobEnqueueFailedException,
    );
  });
});
