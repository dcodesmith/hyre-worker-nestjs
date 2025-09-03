import { getQueueToken } from "@nestjs/bull";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

describe("HealthController", () => {
  let controller: HealthController;
  let healthService: HealthService;

  const mockQueue = {
    add: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            checkHealth: vi.fn(),
            getQueueStats: vi.fn(),
          },
        },
        {
          provide: getQueueToken("reminder-emails"),
          useValue: mockQueue,
        },
        {
          provide: getQueueToken("status-updates"),
          useValue: mockQueue,
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    healthService = module.get<HealthService>(HealthService);
    vi.clearAllMocks();
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  it("should have health service injected", () => {
    expect(healthService).toBeDefined();
  });

  describe("trigger endpoints", () => {
    it("should trigger start reminders", async () => {
      mockQueue.add.mockResolvedValue({ id: "job-123" });

      const result = await controller.triggerReminders();

      expect(result).toEqual({
        success: true,
        message: "Reminder job triggered",
      });
      expect(mockQueue.add).toHaveBeenCalledWith("booking-leg-start-reminder", {
        type: "trip-start",
        timestamp: expect.any(String),
      });
    });

    it("should trigger end reminders", async () => {
      mockQueue.add.mockResolvedValue({ id: "job-124" });

      const result = await controller.triggerEndReminders();

      expect(result).toEqual({
        success: true,
        message: "End reminder job triggered",
      });
      expect(mockQueue.add).toHaveBeenCalledWith("booking-leg-end-reminder", {
        type: "trip-end",
        timestamp: expect.any(String),
      });
    });

    it("should trigger confirmed to active status updates", async () => {
      mockQueue.add.mockResolvedValue({ id: "job-456" });

      const result = await controller.triggerStatusUpdates();

      expect(result).toEqual({
        success: true,
        message: "Status update job triggered",
      });
      expect(mockQueue.add).toHaveBeenCalledWith("confirmed-to-active", {
        type: "confirmed-to-active",
        timestamp: expect.any(String),
      });
    });

    it("should trigger active to completed status updates", async () => {
      mockQueue.add.mockResolvedValue({ id: "job-789" });

      const result = await controller.triggerCompleteBookings();

      expect(result).toEqual({
        success: true,
        message: "Complete bookings job triggered",
      });
      expect(mockQueue.add).toHaveBeenCalledWith("active-to-completed", {
        type: "active-to-completed",
        timestamp: expect.any(String),
      });
    });
  });
});
