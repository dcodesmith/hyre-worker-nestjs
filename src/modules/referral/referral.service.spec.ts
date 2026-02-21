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

    const request = {
      headers: {},
      protocol: "http",
      get: vi.fn().mockReturnValue("localhost:3000"),
    } as unknown as Request;

    await expect(service.getCurrentUserReferralInfo("user-1", request)).rejects.toBeInstanceOf(
      ReferralUserNotFoundException,
    );
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

    const request = {
      headers: {},
      protocol: "http",
      get: vi.fn().mockReturnValue("localhost:3000"),
    } as unknown as Request;

    await expect(service.getCurrentUserReferralInfo("user-1", request)).rejects.toBeInstanceOf(
      ReferralUserFetchFailedException,
    );
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

    const request = {
      headers: {},
      protocol: "http",
      get: vi.fn().mockReturnValue("localhost:3000"),
    } as unknown as Request;

    await service.getCurrentUserReferralInfo("user-1", request);
    await service.getCurrentUserReferralInfo("user-1", request);

    expect(referralApiService.getUserReferralSummary).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
