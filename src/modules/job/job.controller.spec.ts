import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobException } from "./errors";
import { JobController } from "./job.controller";
import { JobService } from "./job.service";

describe("JobController", () => {
  let controller: JobController;
  let jobService: JobService;
  let configService: ConfigService;
  let mockConfigGet: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockConfigGet = vi.fn().mockReturnValue(false);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [JobController],
      providers: [
        {
          provide: JobService,
          useValue: {
            triggerStartBookingLegReminders: vi.fn().mockResolvedValue(undefined),
            triggerBookingLegEndReminders: vi.fn().mockResolvedValue(undefined),
            triggerActivateBookings: vi.fn().mockResolvedValue(undefined),
            triggerCompleteBookings: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: mockConfigGet,
          },
        },
      ],
    }).compile();

    controller = module.get<JobController>(JobController);
    jobService = module.get<JobService>(JobService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  it("should have job service and config service injected", () => {
    expect(jobService).toBeDefined();
    expect(configService).toBeDefined();
  });

  async function createControllerWithConfig(enabled: boolean): Promise<JobController> {
    const configGet = vi.fn((key: string) => {
      if (key === "ENABLE_MANUAL_TRIGGERS") return enabled;
      return undefined;
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [JobController],
      providers: [
        {
          provide: JobService,
          useValue: jobService,
        },
        {
          provide: ConfigService,
          useValue: {
            get: configGet,
          },
        },
      ],
    }).compile();
    return module.get<JobController>(JobController);
  }

  describe("triggerJob", () => {
    it("should throw JobException when manual triggers are disabled", async () => {
      const disabledController = await createControllerWithConfig(false);

      await expect(disabledController.triggerJob("start-reminders")).rejects.toThrow(
        JobException.manualTriggersDisabled(),
      );
    });

    it("should trigger start-reminders job when enabled", async () => {
      const enabledController = await createControllerWithConfig(true);
      const result = await enabledController.triggerJob("start-reminders");

      expect(jobService.triggerStartBookingLegReminders).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        success: true,
        message: "Start reminder job triggered",
      });
    });

    it("should trigger end-reminders job when enabled", async () => {
      const enabledController = await createControllerWithConfig(true);
      const result = await enabledController.triggerJob("end-reminders");

      expect(jobService.triggerBookingLegEndReminders).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        success: true,
        message: "End reminder job triggered",
      });
    });

    it("should trigger activate-bookings job when enabled", async () => {
      const enabledController = await createControllerWithConfig(true);
      const result = await enabledController.triggerJob("activate-bookings");

      expect(jobService.triggerActivateBookings).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        success: true,
        message: "Activate bookings job triggered",
      });
    });

    it("should trigger complete-bookings job when enabled", async () => {
      const enabledController = await createControllerWithConfig(true);
      const result = await enabledController.triggerJob("complete-bookings");

      expect(jobService.triggerCompleteBookings).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        success: true,
        message: "Complete bookings job triggered",
      });
    });

    it("should handle errors from job service", async () => {
      const enabledController = await createControllerWithConfig(true);
      const error = new Error("Job service error");
      vi.mocked(jobService.triggerStartBookingLegReminders).mockRejectedValueOnce(error);

      await expect(enabledController.triggerJob("start-reminders")).rejects.toThrow(error);
    });
  });
});
