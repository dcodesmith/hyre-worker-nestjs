import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { Test, TestingModule } from "@nestjs/testing";
import { ThrottlerStorage } from "@nestjs/throttler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManualTriggersDisabledException } from "./errors";
import { JobController } from "./job.controller";
import { JobService } from "./job.service";
import { JobThrottlerGuard } from "./job-throttler.guard";

describe("JobController", () => {
  let jobService: JobService;
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
        // Mock throttler dependencies for the guard
        {
          provide: "THROTTLER:MODULE_OPTIONS",
          useValue: [{ name: "manual-triggers", ttl: 3600, limit: 1 }],
        },
        {
          provide: ThrottlerStorage,
          useValue: { increment: vi.fn(), get: vi.fn() },
        },
        Reflector,
        JobThrottlerGuard,
      ],
    }).compile();

    jobService = module.get<JobService>(JobService);
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
        // Mock throttler dependencies for the guard
        {
          provide: "THROTTLER:MODULE_OPTIONS",
          useValue: [{ name: "manual-triggers", ttl: 3600, limit: 1 }],
        },
        {
          provide: ThrottlerStorage,
          useValue: { increment: vi.fn(), get: vi.fn() },
        },
        Reflector,
        JobThrottlerGuard,
      ],
    }).compile();
    return module.get<JobController>(JobController);
  }

  describe("triggerJob", () => {
    it("should throw ManualTriggersDisabledException when manual triggers are disabled", async () => {
      const disabledController = await createControllerWithConfig(false);

      await expect(disabledController.triggerJob("start-reminders")).rejects.toThrow(
        ManualTriggersDisabledException,
      );
    });

    it("should handle errors from job service", async () => {
      const enabledController = await createControllerWithConfig(true);
      const error = new Error("Job service error");
      vi.mocked(jobService.triggerStartBookingLegReminders).mockRejectedValueOnce(error);

      await expect(enabledController.triggerJob("start-reminders")).rejects.toThrow(error);
    });
  });
});
