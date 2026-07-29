import { Test, type TestingModule } from "@nestjs/testing";
import {
  BookingReferralStatus,
  BookingStatus,
  PaymentStatus,
  ReferralReleaseCondition,
  ReferralRewardStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { ReferralProcessingService } from "./referral-processing.service";
import { ReferralReconciliationScheduler } from "./referral-reconciliation.scheduler";

describe("ReferralReconciliationScheduler", () => {
  let scheduler: ReferralReconciliationScheduler;
  let databaseService: {
    referralProgramConfig: { findMany: ReturnType<typeof vi.fn> };
    referralReward: {
      findMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };
  let referralProcessingService: {
    queueReferralProcessing: ReturnType<typeof vi.fn>;
  };
  let logger: PinoLogger;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-02T12:02:00.000Z"));
    databaseService = {
      referralProgramConfig: {
        findMany: vi.fn().mockResolvedValue([
          { key: "REFERRAL_ENABLED", value: true },
          { key: "REFERRAL_RELEASE_CONDITION", value: "COMPLETED" },
        ]),
      },
      referralReward: {
        findMany: vi.fn().mockResolvedValue([{ bookingId: "booking-1" }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    referralProcessingService = {
      queueReferralProcessing: vi.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralReconciliationScheduler,
        { provide: DatabaseService, useValue: databaseService },
        { provide: ReferralProcessingService, useValue: referralProcessingService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    scheduler = module.get(ReferralReconciliationScheduler);
    logger = module.get(PinoLogger);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requeues completed bookings with pending rewards", async () => {
    await scheduler.reconcilePendingRewards();

    expect(databaseService.referralReward.findMany).toHaveBeenCalledWith({
      where: {
        status: ReferralRewardStatus.PENDING,
        releaseCondition: ReferralReleaseCondition.COMPLETED,
        OR: [
          { reconciliationLastAttemptAt: null },
          {
            reconciliationLastAttemptAt: {
              lte: new Date("2030-01-02T11:47:00.000Z"),
            },
          },
        ],
        booking: {
          is: {
            deletedAt: null,
            status: BookingStatus.COMPLETED,
            paymentStatus: PaymentStatus.PAID,
            referralStatus: BookingReferralStatus.APPLIED,
          },
        },
      },
      select: { bookingId: true },
      distinct: ["bookingId"],
      orderBy: [
        { reconciliationLastAttemptAt: { sort: "asc", nulls: "first" } },
        { createdAt: "asc" },
      ],
      take: 100,
    });
    expect(databaseService.referralReward.updateMany).toHaveBeenCalledWith({
      where: {
        bookingId: "booking-1",
        status: ReferralRewardStatus.PENDING,
        releaseCondition: ReferralReleaseCondition.COMPLETED,
        OR: [
          { reconciliationLastAttemptAt: null },
          {
            reconciliationLastAttemptAt: {
              lte: new Date("2030-01-02T11:47:00.000Z"),
            },
          },
        ],
      },
      data: { reconciliationLastAttemptAt: new Date("2030-01-02T12:02:00.000Z") },
    });
    const bucket = Math.floor(new Date("2030-01-02T12:02:00.000Z").getTime() / (15 * 60 * 1000));
    expect(referralProcessingService.queueReferralProcessing).toHaveBeenCalledWith(
      "booking-1",
      `referral-reconcile-booking-1-${bucket}`,
    );
    expect(logger.info).toHaveBeenCalledWith(
      { found: 1, enqueued: 1, failed: 0, skipped: 0 },
      "Reconciled pending referral rewards",
    );
  });

  it("warns when the reconciliation batch is saturated", async () => {
    databaseService.referralReward.findMany.mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, index) => ({ bookingId: `booking-${index}` })),
    );

    await scheduler.reconcilePendingRewards();

    expect(logger.warn).toHaveBeenCalledWith(
      { batchSize: 100 },
      "Referral reward reconciliation batch is saturated",
    );
  });

  it("does not enqueue when completion release is disabled", async () => {
    databaseService.referralProgramConfig.findMany.mockResolvedValueOnce([
      { key: "REFERRAL_ENABLED", value: false },
      { key: "REFERRAL_RELEASE_CONDITION", value: "COMPLETED" },
    ]);

    await scheduler.reconcilePendingRewards();

    expect(databaseService.referralReward.findMany).not.toHaveBeenCalled();
    expect(referralProcessingService.queueReferralProcessing).not.toHaveBeenCalled();
  });

  it("excludes rewards whose referral eligibility has expired", async () => {
    databaseService.referralProgramConfig.findMany.mockResolvedValueOnce([
      { key: "REFERRAL_ENABLED", value: true },
      { key: "REFERRAL_RELEASE_CONDITION", value: "COMPLETED" },
      { key: "REFERRAL_EXPIRY_DAYS", value: 30 },
    ]);

    await scheduler.reconcilePendingRewards();

    expect(databaseService.referralReward.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          referee: {
            is: {
              OR: [
                { referralSignupAt: null },
                {
                  referralSignupAt: {
                    gt: new Date("2029-12-03T12:02:00.000Z"),
                  },
                },
              ],
            },
          },
        }),
      }),
    );
  });

  it("continues after an enqueue failure", async () => {
    databaseService.referralReward.findMany.mockResolvedValueOnce([
      { bookingId: "booking-1" },
      { bookingId: "booking-2" },
    ]);
    referralProcessingService.queueReferralProcessing
      .mockRejectedValueOnce(new Error("Redis unavailable"))
      .mockResolvedValueOnce(undefined);

    await scheduler.reconcilePendingRewards();

    expect(referralProcessingService.queueReferralProcessing).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      { bookingId: "booking-1", error: "Redis unavailable" },
      "Failed to requeue pending referral reward",
    );
    expect(logger.info).toHaveBeenCalledWith(
      { found: 2, enqueued: 1, failed: 1, skipped: 0 },
      "Reconciled pending referral rewards",
    );
  });

  it("skips a booking claimed by another scheduler instance", async () => {
    databaseService.referralReward.updateMany.mockResolvedValueOnce({ count: 0 });

    await scheduler.reconcilePendingRewards();

    expect(referralProcessingService.queueReferralProcessing).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { found: 1, enqueued: 0, failed: 0, skipped: 1 },
      "Reconciled pending referral rewards",
    );
  });

  it("logs query failures without rejecting the cron invocation", async () => {
    databaseService.referralReward.findMany.mockRejectedValueOnce(
      new Error("Database unavailable"),
    );

    await expect(scheduler.reconcilePendingRewards()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      { error: "Database unavailable" },
      "Failed to reconcile pending referral rewards",
    );
  });
});
