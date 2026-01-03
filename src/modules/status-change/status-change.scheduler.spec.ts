import { getQueueToken } from "@nestjs/bullmq";
import { Test, TestingModule } from "@nestjs/testing";
import { Queue } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STATUS_UPDATES_QUEUE,
  CONFIRMED_TO_ACTIVE,
  ACTIVE_TO_COMPLETED,
} from "../../config/constants";
import { StatusUpdateJobData } from "./status-change.interface";
import { StatusChangeScheduler } from "./status-change.scheduler";

describe("StatusChangeScheduler", () => {
  let scheduler: StatusChangeScheduler;
  let statusUpdateQueue: Queue<StatusUpdateJobData>;

  beforeEach(async () => {
    const mockQueue = {
      add: vi.fn().mockResolvedValue({ id: "job-123" }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusChangeScheduler,
        {
          provide: getQueueToken(STATUS_UPDATES_QUEUE),
          useValue: mockQueue,
        },
      ],
    }).compile();

    scheduler = module.get<StatusChangeScheduler>(StatusChangeScheduler);
    statusUpdateQueue = module.get<Queue<StatusUpdateJobData>>(getQueueToken(STATUS_UPDATES_QUEUE));
  });

  it("should be defined", () => {
    expect(scheduler).toBeDefined();
  });

  it("should have status update queue injected", () => {
    expect(statusUpdateQueue).toBeDefined();
  });

  describe("scheduleConfirmedToActiveUpdates", () => {
    it("should add confirmed to active job to queue", async () => {
      await scheduler.scheduleConfirmedToActiveUpdates();

      expect(statusUpdateQueue.add).toHaveBeenCalledWith(CONFIRMED_TO_ACTIVE, {
        type: CONFIRMED_TO_ACTIVE,
      });
    });

    it("should handle errors when queueing fails", async () => {
      const error = new Error("Queue error");
      vi.mocked(statusUpdateQueue.add).mockRejectedValueOnce(error);

      // Should not throw, just log error
      await expect(scheduler.scheduleConfirmedToActiveUpdates()).resolves.toBeUndefined();
    });
  });

  describe("scheduleActiveToCompletedUpdates", () => {
    it("should add active to completed job to queue", async () => {
      await scheduler.scheduleActiveToCompletedUpdates();

      expect(statusUpdateQueue.add).toHaveBeenCalledWith(ACTIVE_TO_COMPLETED, {
        type: ACTIVE_TO_COMPLETED,
      });
    });

    it("should handle errors when queueing fails", async () => {
      const error = new Error("Queue error");
      vi.mocked(statusUpdateQueue.add).mockRejectedValueOnce(error);

      // Should not throw, just log error
      await expect(scheduler.scheduleActiveToCompletedUpdates()).resolves.toBeUndefined();
    });
  });
});
