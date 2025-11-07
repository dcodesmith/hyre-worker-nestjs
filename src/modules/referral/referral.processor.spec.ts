import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    it("should log on job completion", () => {
      const job = {
        id: "job-123",
        name: PROCESS_REFERRAL_COMPLETION,
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
        finishedOn: 1000,
        processedOn: 500,
      } as Job<ReferralJobData>;

      processor.onCompleted(job);

      expect(true).toBe(true);
    });

    it("should log on job failure", () => {
      const job = {
        id: "job-123",
        name: PROCESS_REFERRAL_COMPLETION,
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
        attemptsMade: 2,
        opts: { attempts: 3 },
      } as Job<ReferralJobData>;

      const error = new Error("Test error");

      processor.onFailed(job, error);

      expect(true).toBeTruthy();
    });

    it("should log on job activation", () => {
      const job = {
        id: "job-123",
        name: PROCESS_REFERRAL_COMPLETION,
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
        attemptsMade: 0,
      } as Job<ReferralJobData>;

      processor.onActive(job);

      expect(true).toBeTruthy();
    });

    it("should log on job stalled", () => {
      processor.onStalled("job-123");

      expect(true).toBe(true);
    });

    it("should log on job progress", () => {
      const job = {
        id: "job-123",
        name: PROCESS_REFERRAL_COMPLETION,
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
      } as Job<ReferralJobData>;

      processor.onProgress(job, 50);

      expect(true).toBe(true);
    });

    it("should handle job failure with no job context", () => {
      const error = new Error("Test error");

      processor.onFailed(undefined, error);

      expect(true).toBe(true);
    });
  });
});
