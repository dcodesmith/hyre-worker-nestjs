import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROCESS_REFERRAL_COMPLETION, ReferralJobData } from "./referral.interface";
import { ReferralProcessor } from "./referral.processor";
import { ReferralService } from "./referral.service";

describe("ReferralProcessor", () => {
  let processor: ReferralProcessor;
  let referralService: ReferralService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralProcessor,
        {
          provide: ReferralService,
          useValue: {
            processReferralCompletionForBooking: vi.fn(),
          },
        },
      ],
    }).compile();

    processor = module.get<ReferralProcessor>(ReferralProcessor);
    referralService = module.get<ReferralService>(ReferralService);
  });

  it("should be defined", () => {
    expect(processor).toBeDefined();
  });

  describe("process", () => {
    it("should process referral completion job successfully", async () => {
      const job = {
        id: "job-123",
        name: PROCESS_REFERRAL_COMPLETION,
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
      } as Job<ReferralJobData, void, string>;

      vi.mocked(referralService.processReferralCompletionForBooking).mockResolvedValue(undefined);

      const result = await processor.process(job);

      expect(result).toEqual({ success: true });
      expect(referralService.processReferralCompletionForBooking).toHaveBeenCalledWith(
        "booking-123",
      );
    });

    it("should throw error for unknown job type", async () => {
      const job = {
        id: "job-123",
        name: "unknown-job-type",
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
      } as Job<ReferralJobData, void, string>;

      await expect(processor.process(job)).rejects.toThrow(
        "Unknown referral job type: unknown-job-type",
      );
      expect(referralService.processReferralCompletionForBooking).not.toHaveBeenCalled();
    });

    it("should re-throw error when referral service fails", async () => {
      const job = {
        id: "job-123",
        name: PROCESS_REFERRAL_COMPLETION,
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
      } as Job<ReferralJobData, void, string>;

      const serviceError = new Error("Database connection failed");
      vi.mocked(referralService.processReferralCompletionForBooking).mockRejectedValue(
        serviceError,
      );

      await expect(processor.process(job)).rejects.toThrow("Database connection failed");
      expect(referralService.processReferralCompletionForBooking).toHaveBeenCalledWith(
        "booking-123",
      );
    });
  });

  describe("event handlers", () => {
    let loggerLogSpy: ReturnType<typeof vi.spyOn>;
    let loggerErrorSpy: ReturnType<typeof vi.spyOn>;
    let loggerWarnSpy: ReturnType<typeof vi.spyOn>;
    let loggerDebugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Mock all logger methods
      // eslint-disable-next-line @typescript-eslint/dot-notation
      loggerLogSpy = vi.spyOn(processor["logger"], "log");
      // eslint-disable-next-line @typescript-eslint/dot-notation
      loggerErrorSpy = vi.spyOn(processor["logger"], "error");
      // eslint-disable-next-line @typescript-eslint/dot-notation
      loggerWarnSpy = vi.spyOn(processor["logger"], "warn");
      // eslint-disable-next-line @typescript-eslint/dot-notation
      loggerDebugSpy = vi.spyOn(processor["logger"], "debug");
    });

    afterEach(() => {
      // Reset all mocks between tests
      vi.clearAllMocks();
    });

    describe("onCompleted", () => {
      it("should log completion with job details and duration", () => {
        const job = {
          id: "job-123",
          name: PROCESS_REFERRAL_COMPLETION,
          data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
          finishedOn: 1500,
          processedOn: 500,
        } as Job<ReferralJobData>;

        processor.onCompleted(job);

        expect(loggerLogSpy).toHaveBeenCalledTimes(1);
        expect(loggerLogSpy).toHaveBeenCalledWith(
          `Job completed: ${PROCESS_REFERRAL_COMPLETION} [job-123] - Duration: 1000ms`,
          { bookingId: "booking-123" },
        );
      });

      it("should log completion with N/A duration when timestamps are missing", () => {
        const job = {
          id: "job-456",
          name: PROCESS_REFERRAL_COMPLETION,
          data: { bookingId: "booking-456", timestamp: new Date().toISOString() },
          finishedOn: undefined,
          processedOn: undefined,
        } as Job<ReferralJobData>;

        processor.onCompleted(job);

        expect(loggerLogSpy).toHaveBeenCalledTimes(1);
        expect(loggerLogSpy).toHaveBeenCalledWith(
          `Job completed: ${PROCESS_REFERRAL_COMPLETION} [job-456] - Duration: N/Ams`,
          { bookingId: "booking-456" },
        );
      });
    });

    describe("onFailed", () => {
      it("should log failure with job details, error, and attempt information", () => {
        const job = {
          id: "job-123",
          name: PROCESS_REFERRAL_COMPLETION,
          data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
          attemptsMade: 2,
          opts: { attempts: 3 },
        } as Job<ReferralJobData>;

        const error = new Error("Database connection failed");
        error.stack = "Error: Database connection failed\n  at line 1";

        processor.onFailed(job, error);

        expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
        expect(loggerErrorSpy).toHaveBeenCalledWith(
          `Job failed: ${PROCESS_REFERRAL_COMPLETION} [job-123]`,
          {
            bookingId: "booking-123",
            error: "Database connection failed",
            stack: "Error: Database connection failed\n  at line 1",
            attempts: 2,
            maxAttempts: 3,
          },
        );
      });

      it("should handle job failure with undefined job context", () => {
        const error = new Error("Unknown error");

        processor.onFailed(undefined, error);

        expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
        expect(loggerErrorSpy).toHaveBeenCalledWith("Job failed with no job context", {
          error: "Unknown error",
        });
      });

      it("should handle error without stack trace", () => {
        const job = {
          id: "job-789",
          name: PROCESS_REFERRAL_COMPLETION,
          data: { bookingId: "booking-789", timestamp: new Date().toISOString() },
          attemptsMade: 1,
          opts: { attempts: 3 },
        } as Job<ReferralJobData>;

        const error = new Error("Simple error");
        error.stack = undefined;

        processor.onFailed(job, error);

        expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
        expect(loggerErrorSpy).toHaveBeenCalledWith(
          `Job failed: ${PROCESS_REFERRAL_COMPLETION} [job-789]`,
          {
            bookingId: "booking-789",
            error: "Simple error",
            stack: undefined,
            attempts: 1,
            maxAttempts: 3,
          },
        );
      });
    });

    describe("onActive", () => {
      it("should log job activation with attempt number", () => {
        const job = {
          id: "job-123",
          name: PROCESS_REFERRAL_COMPLETION,
          data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
          attemptsMade: 0,
        } as Job<ReferralJobData>;

        processor.onActive(job);

        expect(loggerLogSpy).toHaveBeenCalledTimes(1);
        expect(loggerLogSpy).toHaveBeenCalledWith(
          `Job started: ${PROCESS_REFERRAL_COMPLETION} [job-123] - Attempt 1`,
          { bookingId: "booking-123" },
        );
      });

      it("should log correct attempt number for retried jobs", () => {
        const job = {
          id: "job-456",
          name: PROCESS_REFERRAL_COMPLETION,
          data: { bookingId: "booking-456", timestamp: new Date().toISOString() },
          attemptsMade: 2,
        } as Job<ReferralJobData>;

        processor.onActive(job);

        expect(loggerLogSpy).toHaveBeenCalledTimes(1);
        expect(loggerLogSpy).toHaveBeenCalledWith(
          `Job started: ${PROCESS_REFERRAL_COMPLETION} [job-456] - Attempt 3`,
          { bookingId: "booking-456" },
        );
      });
    });

    describe("onStalled", () => {
      it("should log warning when job stalls", () => {
        processor.onStalled("job-123");

        expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
        expect(loggerWarnSpy).toHaveBeenCalledWith("Job stalled: job-123");
      });

      it("should handle different job IDs", () => {
        processor.onStalled("job-xyz-789");

        expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
        expect(loggerWarnSpy).toHaveBeenCalledWith("Job stalled: job-xyz-789");
      });
    });

    describe("onProgress", () => {
      it("should log debug message with numeric progress", () => {
        const job = {
          id: "job-123",
          name: PROCESS_REFERRAL_COMPLETION,
          data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
        } as Job<ReferralJobData>;

        processor.onProgress(job, 50);

        expect(loggerDebugSpy).toHaveBeenCalledTimes(1);
        expect(loggerDebugSpy).toHaveBeenCalledWith(
          `Job progress: ${PROCESS_REFERRAL_COMPLETION} [job-123]`,
          {
            bookingId: "booking-123",
            progress: 50,
          },
        );
      });

      it("should log debug message with object progress", () => {
        const job = {
          id: "job-456",
          name: PROCESS_REFERRAL_COMPLETION,
          data: { bookingId: "booking-456", timestamp: new Date().toISOString() },
        } as Job<ReferralJobData>;

        const progressData = { step: "validation", percentage: 75 };

        processor.onProgress(job, progressData);

        expect(loggerDebugSpy).toHaveBeenCalledTimes(1);
        expect(loggerDebugSpy).toHaveBeenCalledWith(
          `Job progress: ${PROCESS_REFERRAL_COMPLETION} [job-456]`,
          {
            bookingId: "booking-456",
            progress: progressData,
          },
        );
      });

      it("should handle zero progress", () => {
        const job = {
          id: "job-789",
          name: PROCESS_REFERRAL_COMPLETION,
          data: { bookingId: "booking-789", timestamp: new Date().toISOString() },
        } as Job<ReferralJobData>;

        processor.onProgress(job, 0);

        expect(loggerDebugSpy).toHaveBeenCalledTimes(1);
        expect(loggerDebugSpy).toHaveBeenCalledWith(
          `Job progress: ${PROCESS_REFERRAL_COMPLETION} [job-789]`,
          {
            bookingId: "booking-789",
            progress: 0,
          },
        );
      });
    });
  });
});
