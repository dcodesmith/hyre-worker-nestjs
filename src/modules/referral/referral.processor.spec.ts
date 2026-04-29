import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { PROCESS_REFERRAL_COMPLETION, ReferralJobData } from "./referral.interface";
import { ReferralProcessor } from "./referral.processor";
import { ReferralProcessingService } from "./referral-processing.service";

describe("ReferralProcessor", () => {
  let processor: ReferralProcessor;
  let referralProcessingService: ReferralProcessingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralProcessor,
        {
          provide: ReferralProcessingService,
          useValue: {
            processReferralCompletionForBooking: vi.fn(),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    processor = module.get<ReferralProcessor>(ReferralProcessor);
    referralProcessingService = module.get<ReferralProcessingService>(ReferralProcessingService);
  });

  describe("process", () => {
    it("processes referral completion jobs successfully", async () => {
      const job = {
        id: "job-123",
        name: PROCESS_REFERRAL_COMPLETION,
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
      } as Job<ReferralJobData, void, string>;

      vi.mocked(referralProcessingService.processReferralCompletionForBooking).mockResolvedValue(
        undefined,
      );

      const result = await processor.process(job);

      expect(result).toEqual({ success: true });
      expect(referralProcessingService.processReferralCompletionForBooking).toHaveBeenCalledWith(
        "booking-123",
      );
    });

    it("throws for unknown job types", async () => {
      const job = {
        id: "job-123",
        name: "unknown-job-type",
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
      } as Job<ReferralJobData, void, string>;

      await expect(processor.process(job)).rejects.toThrow(
        "Unknown referral job type: unknown-job-type",
      );
      expect(referralProcessingService.processReferralCompletionForBooking).not.toHaveBeenCalled();
    });

    it("rethrows downstream processing errors", async () => {
      const job = {
        id: "job-123",
        name: PROCESS_REFERRAL_COMPLETION,
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
      } as Job<ReferralJobData, void, string>;

      vi.mocked(referralProcessingService.processReferralCompletionForBooking).mockRejectedValue(
        new Error("Database connection failed"),
      );

      await expect(processor.process(job)).rejects.toThrow("Database connection failed");
    });
  });

  describe("event handlers", () => {
    it("handles completed events", () => {
      const job = {
        id: "job-123",
        name: PROCESS_REFERRAL_COMPLETION,
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
        finishedOn: 1500,
        processedOn: 500,
      } as Job<ReferralJobData>;

      expect(() => processor.onCompleted(job)).not.toThrow();
    });

    it("handles failed events with and without job context", () => {
      const job = {
        id: "job-123",
        name: PROCESS_REFERRAL_COMPLETION,
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
        attemptsMade: 2,
        opts: { attempts: 3 },
      } as Job<ReferralJobData>;

      expect(() => processor.onFailed(job, new Error("failure"))).not.toThrow();
      expect(() => processor.onFailed(undefined, new Error("unknown"))).not.toThrow();
    });

    it("handles active, stalled, and progress events", () => {
      const job = {
        id: "job-123",
        name: PROCESS_REFERRAL_COMPLETION,
        data: { bookingId: "booking-123", timestamp: new Date().toISOString() },
        attemptsMade: 1,
      } as Job<ReferralJobData>;

      expect(() => processor.onActive(job)).not.toThrow();
      expect(() => processor.onStalled("job-123")).not.toThrow();
      expect(() => processor.onProgress(job, 50)).not.toThrow();
      expect(() => processor.onProgress(job, { step: "queued" })).not.toThrow();
    });
  });
});
