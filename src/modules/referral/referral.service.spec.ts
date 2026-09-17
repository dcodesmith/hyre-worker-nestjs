import { Test, type TestingModule } from "@nestjs/testing";
import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  ReferralEligibilityCheckFailedException,
  ReferralInvalidCodeException,
  ReferralUserFetchFailedException,
  ReferralUserNotFoundException,
  ReferralValidationFailedException,
} from "./referral.error";
import { ReferralService } from "./referral.service";
import { ReferralApiService } from "./referral-api.service";

describe("ReferralService", () => {
  let service: ReferralService;
  let referralApiService: ReferralApiService;
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
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<ReferralService>(ReferralService);
    referralApiService = module.get<ReferralApiService>(ReferralApiService);
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

  it("reads the latest referral summary on each request", async () => {
    const summary = {
      referralCode: "ABCDEFGH",
      shareLink: "http://localhost:3000/auth?ref=ABCDEFGH",
      programEnabled: true,
      discountAmount: 10000,
      discount: { type: "FIXED" as const, amount: 10000 },
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
    };
    vi.mocked(referralApiService.getUserReferralSummary).mockResolvedValue(summary);

    const first = await service.getCurrentUserReferralInfo("user-1", buildRequest());
    const second = await service.getCurrentUserReferralInfo("user-1", buildRequest());

    expect(first).toEqual(summary);
    expect(second).toEqual(summary);
    expect(referralApiService.getUserReferralSummary).toHaveBeenCalledTimes(2);
  });
});
