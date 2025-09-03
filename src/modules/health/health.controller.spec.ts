import { getQueueToken } from "@nestjs/bull";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

describe("HealthController", () => {
  let controller: HealthController;
  let healthService: HealthService;

  const mockHealthService = {
    checkHealth: vi.fn(),
    getQueueStats: vi.fn(),
  };

  const mockQueue = {
    add: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: mockHealthService,
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
    it("should trigger reminders", async () => {
      mockQueue.add.mockResolvedValue({ id: "job-123" });

      const result = await controller.triggerReminders();

      expect(result).toEqual({
        success: true,
        message: "Reminder job triggered",
      });
      expect(mockQueue.add).toHaveBeenCalledWith("send-reminders", {
        type: "trip-start",
        timestamp: expect.any(String),
      });
    });

    it("should trigger status updates", async () => {
      mockQueue.add.mockResolvedValue({ id: "job-456" });

      const result = await controller.triggerStatusUpdates();

      expect(result).toEqual({
        success: true,
        message: "Status update job triggered",
      });
      expect(mockQueue.add).toHaveBeenCalledWith("update-status", {
        type: "confirmed-to-active",
        timestamp: expect.any(String),
      });
    });
  });
});
