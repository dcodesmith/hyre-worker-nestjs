import { getQueueToken } from "@nestjs/bullmq";
import { Test, TestingModule } from "@nestjs/testing";
import { Queue } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOKING_LEG_END_REMINDER,
  BOOKING_LEG_START_REMINDER,
  REMINDERS_QUEUE,
  TRIP_END,
  TRIP_START,
} from "../../config/constants";
import { ReminderJobData } from "./reminder.interface";
import { ReminderScheduler } from "./reminder.scheduler";

describe("ReminderScheduler", () => {
  let scheduler: ReminderScheduler;
  let reminderQueue: Queue<ReminderJobData>;

  beforeEach(async () => {
    const mockQueue = {
      add: vi.fn().mockResolvedValue({ id: "job-123" }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReminderScheduler,
        {
          provide: getQueueToken(REMINDERS_QUEUE),
          useValue: mockQueue,
        },
      ],
    }).compile();

    scheduler = module.get<ReminderScheduler>(ReminderScheduler);
    reminderQueue = module.get<Queue<ReminderJobData>>(getQueueToken(REMINDERS_QUEUE));
  });
  describe("scheduleBookingStartReminders", () => {
    it("should add start reminder job to queue", async () => {
      await scheduler.scheduleBookingStartReminders();

      expect(reminderQueue.add).toHaveBeenCalledWith(
        BOOKING_LEG_START_REMINDER,
        expect.objectContaining({
          type: TRIP_START,
          timestamp: expect.any(String),
        }),
        {
          removeOnComplete: true,
          removeOnFail: 25,
        },
      );
    });

    it("should handle errors when queueing fails", async () => {
      const error = new Error("Queue error");
      vi.mocked(reminderQueue.add).mockRejectedValueOnce(error);

      // Should not throw, just log error
      await expect(scheduler.scheduleBookingStartReminders()).resolves.toBeUndefined();
    });
  });

  describe("scheduleBookingEndReminders", () => {
    it("should add end reminder job to queue", async () => {
      await scheduler.scheduleBookingEndReminders();

      expect(reminderQueue.add).toHaveBeenCalledWith(
        BOOKING_LEG_END_REMINDER,
        expect.objectContaining({
          type: TRIP_END,
          timestamp: expect.any(String),
        }),
        {
          removeOnComplete: true,
          removeOnFail: 25,
        },
      );
    });

    it("should handle errors when queueing fails", async () => {
      const error = new Error("Queue error");
      vi.mocked(reminderQueue.add).mockRejectedValueOnce(error);

      // Should not throw, just log error
      await expect(scheduler.scheduleBookingEndReminders()).resolves.toBeUndefined();
    });
  });
});
