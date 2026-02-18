import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth/auth.service";
import type { AuthSession } from "../auth/guards/session.guard";
import { ReferralController } from "./referral.controller";
import { ReferralService } from "./referral.service";

function createMockAuthUser(overrides: Partial<AuthSession["user"]> = {}): AuthSession["user"] {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "user-1",
    createdAt: now,
    updatedAt: now,
    emailVerified: false,
    name: "Test User",
    email: "test-user@example.com",
    image: null,
    roles: ["user"],
    ...overrides,
  };
}

describe("ReferralController", () => {
  let controller: ReferralController;
  let referralService: ReferralService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: "default",
            ttl: 3600,
            limit: 10,
          },
        ]),
      ],
      controllers: [ReferralController],
      providers: [
        {
          provide: ReferralService,
          useValue: {
            validateReferralCode: vi.fn(),
            getReferralEligibility: vi.fn(),
            getCurrentUserReferralInfo: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            isInitialized: true,
            auth: {
              api: {
                getSession: vi.fn().mockResolvedValue(null),
              },
            },
            getUserRoles: vi.fn().mockResolvedValue(["user"]),
          },
        },
        Reflector,
      ],
    }).compile();

    controller = module.get<ReferralController>(ReferralController);
    referralService = module.get<ReferralService>(ReferralService);
  });

  it("validates referral code and returns successful payload", async () => {
    vi.mocked(referralService.validateReferralCode).mockResolvedValue({
      valid: true,
      referrer: { name: "Referrer Name" },
      message: "Valid referral code.",
    });

    const response = {
      setHeader: vi.fn(),
    };

    const result = await controller.validateReferralCode(
      "ABCDEFGH",
      { email: "new-user@example.com" },
      response as unknown as Response,
    );

    expect(result).toEqual({
      valid: true,
      referrer: { name: "Referrer Name" },
      message: "Valid referral code.",
    });
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it("returns eligibility payload for authenticated user", async () => {
    vi.mocked(referralService.getReferralEligibility).mockResolvedValue({
      eligible: true,
      discountAmount: 5000,
      reason: undefined,
    });

    const result = await controller.getReferralEligibility(createMockAuthUser(), {
      amount: 50000,
      type: "DAY",
    });

    expect(result).toEqual({
      eligible: true,
      discountAmount: 5000,
      reason: undefined,
    });
  });

  it("returns user referral info for authenticated user", async () => {
    vi.mocked(referralService.getCurrentUserReferralInfo).mockResolvedValue({
      referralCode: "ABCDEFGH",
      shareLink: "http://localhost:3000/auth?ref=ABCDEFGH",
      hasUsedDiscount: false,
      referredBy: null,
      signupDate: null,
      stats: {
        totalReferrals: 1,
        totalRewardsGranted: 1000,
        totalRewardsPending: 0,
        lastReferralAt: null,
        totalEarned: 1000,
        totalUsed: 0,
        availableCredits: 1000,
        maxCreditsPerBooking: 30000,
      },
      referrals: [],
      rewards: [],
    });

    const request = {
      headers: {},
      protocol: "http",
      get: vi.fn().mockReturnValue("localhost:3000"),
    } as never;

    const result = await controller.getCurrentUserReferralInfo(createMockAuthUser(), request);

    expect(result.referralCode).toBe("ABCDEFGH");
    expect(referralService.getCurrentUserReferralInfo).toHaveBeenCalledWith("user-1", request);
  });
});
