import { Test, type TestingModule } from "@nestjs/testing";
import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReferralEligibilityCheckFailedException,
  ReferralInvalidCodeException,
  ReferralUserFetchFailedException,
  ReferralUserNotFoundException,
  ReferralValidationFailedException,
} from "./referral.error";
import { ReferralService } from "./referral.service";
import { ReferralApiService } from "./referral-api.service";
import { ReferralProcessingService } from "./referral-processing.service";

describe("ReferralService", () => {
  let service: ReferralService;
  let referralApiService: ReferralApiService;
  let referralProcessingService: ReferralProcessingService;
  const buildRequest = (origin = "localhost:3000") =>
    ({
      headers: {},
      protocol: "http",
      get: vi.fn().mockReturnValue(origin),
    }) as unknown as Request;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralService,
        {
          provide: ReferralApiService,
          useValue: {
            validateReferralCode: vi.fn(),
            checkReferralEligibility: vi.fn(),
            getUserReferralSummary: vi.fn(),
          },
        },
        {
          provide: ReferralProcessingService,
          useValue: {
            queueReferralProcessing: vi.fn(),
            processReferralCompletionForBooking: vi.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ReferralService>(ReferralService);
    referralApiService = module.get<ReferralApiService>(ReferralApiService);
    referralProcessingService = module.get<ReferralProcessingService>(ReferralProcessingService);
  });

  it("delegates queue referral processing", async () => {
    await service.queueReferralProcessing("booking-1");
    expect(referralProcessingService.queueReferralProcessing).toHaveBeenCalledWith("booking-1");
  });

  it("returns normalized validate payload", async () => {
    vi.mocked(referralApiService.validateReferralCode).mockResolvedValue({
      id: "user-1",
      email: "referrer@example.com",
      referralCode: "ABCDEFGH",
      name: null,
    });

    const result = await service.validateReferralCode("ABCDEFGH", {
      email: "new@example.com",
    });

    expect(result).toEqual({
      valid: true,
      referrer: { name: "Anonymous" },
      message: "Valid referral code.",
    });
  });

  it("rethrows known referral errors during validation", async () => {
    const knownError = new ReferralInvalidCodeException();
    vi.mocked(referralApiService.validateReferralCode).mockRejectedValue(knownError);

    await expect(
      service.validateReferralCode("ABCDEFGH", {
        email: "new@example.com",
      }),
    ).rejects.toBe(knownError);
  });

  it("throws generic validation failed error for unknown exceptions", async () => {
    vi.mocked(referralApiService.validateReferralCode).mockRejectedValue(new Error("boom"));

    await expect(
      service.validateReferralCode("ABCDEFGH", {
        email: "new@example.com",
      }),
    ).rejects.toBeInstanceOf(ReferralValidationFailedException);
  });

  it("throws user not found when referral summary is missing", async () => {
    vi.mocked(referralApiService.getUserReferralSummary).mockResolvedValue(null);
    await expect(
      service.getCurrentUserReferralInfo("user-1", buildRequest()),
    ).rejects.toBeInstanceOf(ReferralUserNotFoundException);
  });

  it("throws generic eligibility failed error for unknown exceptions", async () => {
    vi.mocked(referralApiService.checkReferralEligibility).mockRejectedValue(new Error("boom"));

    await expect(
      service.getReferralEligibility("user-1", {
        amount: 20000,
        type: "DAY",
      }),
    ).rejects.toBeInstanceOf(ReferralEligibilityCheckFailedException);
  });

  it("throws generic referral fetch failed for unknown exceptions", async () => {
    vi.mocked(referralApiService.getUserReferralSummary).mockRejectedValue(new Error("boom"));
    await expect(
      service.getCurrentUserReferralInfo("user-1", buildRequest()),
    ).rejects.toBeInstanceOf(ReferralUserFetchFailedException);
  });

  it("returns cached referral summary within ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    vi.mocked(referralApiService.getUserReferralSummary).mockResolvedValue({
      referralCode: "ABCDEFGH",
      shareLink: "http://localhost:3000/auth?ref=ABCDEFGH",
      hasUsedDiscount: false,
      referredBy: null,
      signupDate: null,
      stats: {
        totalReferrals: 0,
        totalRewardsGranted: 0,
        totalRewardsPending: 0,
        lastReferralAt: null,
        totalEarned: 0,
        totalUsed: 0,
        availableCredits: 0,
        maxCreditsPerBooking: 30000,
      },
      referrals: [],
      rewards: [],
    });

    await service.getCurrentUserReferralInfo("user-1", buildRequest());
    await service.getCurrentUserReferralInfo("user-1", buildRequest());

    expect(referralApiService.getUserReferralSummary).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("evicts expired key on read and refetches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    vi.mocked(referralApiService.getUserReferralSummary)
      .mockResolvedValueOnce({
        referralCode: "FIRST",
        shareLink: "http://localhost:3000/auth?ref=FIRST",
        hasUsedDiscount: false,
        referredBy: null,
        signupDate: null,
        stats: {
          totalReferrals: 0,
          totalRewardsGranted: 0,
          totalRewardsPending: 0,
          lastReferralAt: null,
          totalEarned: 0,
          totalUsed: 0,
          availableCredits: 0,
          maxCreditsPerBooking: 30000,
        },
        referrals: [],
        rewards: [],
      })
      .mockResolvedValueOnce({
        referralCode: "SECOND",
        shareLink: "http://localhost:3000/auth?ref=SECOND",
        hasUsedDiscount: false,
        referredBy: null,
        signupDate: null,
        stats: {
          totalReferrals: 0,
          totalRewardsGranted: 0,
          totalRewardsPending: 0,
          lastReferralAt: null,
          totalEarned: 0,
          totalUsed: 0,
          availableCredits: 0,
          maxCreditsPerBooking: 30000,
        },
        referrals: [],
        rewards: [],
      });

    const first = await service.getCurrentUserReferralInfo("user-1", buildRequest());
    vi.advanceTimersByTime(31_000);
    const second = await service.getCurrentUserReferralInfo("user-1", buildRequest());

    expect(first.referralCode).toBe("FIRST");
    expect(second.referralCode).toBe("SECOND");
    expect(referralApiService.getUserReferralSummary).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("prunes unrelated expired cache entries during writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    vi.mocked(referralApiService.getUserReferralSummary).mockImplementation(async (userId) => ({
      referralCode: userId,
      shareLink: `http://localhost:3000/auth?ref=${userId}`,
      hasUsedDiscount: false,
      referredBy: null,
      signupDate: null,
      stats: {
        totalReferrals: 0,
        totalRewardsGranted: 0,
        totalRewardsPending: 0,
        lastReferralAt: null,
        totalEarned: 0,
        totalUsed: 0,
        availableCredits: 0,
        maxCreditsPerBooking: 30000,
      },
      referrals: [],
      rewards: [],
    }));

    await service.getCurrentUserReferralInfo("user-1", buildRequest("one.local"));
    await service.getCurrentUserReferralInfo("user-2", buildRequest("two.local"));

    vi.advanceTimersByTime(31_000);
    await service.getCurrentUserReferralInfo("user-3", buildRequest("three.local"));

    const cache = (
      service as unknown as {
        userSummaryCache: Map<string, { expiresAt: number }>;
      }
    ).userSummaryCache;
    const keys = [...cache.keys()];

    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("user-3:");
    expect(referralApiService.getUserReferralSummary).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });
});
