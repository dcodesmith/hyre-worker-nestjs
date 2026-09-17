import { Test, type TestingModule } from "@nestjs/testing";
import {
  BookingReferralStatus,
  ReferralIncentiveType,
  ReferralProgramStatus,
} from "@prisma/client";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReferralProgram } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import {
  ReferralInvalidCodeException,
  ReferralProgramInactiveException,
  ReferralSelfReferralException,
} from "./referral.error";
import { ReferralApiService } from "./referral-api.service";
import { ReferralProgramService } from "./referral-program.service";

describe("ReferralApiService", () => {
  let service: ReferralApiService;
  let mockDatabaseService: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
    };
    booking: {
      findFirst: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
    };
    referralReward: {
      aggregate: ReturnType<typeof vi.fn>;
    };
    userReferralStats: {
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
  let referralProgramService: {
    getActiveProgram: ReturnType<typeof vi.fn>;
    getProgram: ReturnType<typeof vi.fn>;
    calculateRefereeDiscount: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    mockDatabaseService = {
      user: {
        findUnique: vi.fn(),
      },
      booking: {
        findFirst: vi.fn(),
        aggregate: vi.fn(),
      },
      referralReward: {
        aggregate: vi.fn(),
      },
      userReferralStats: {
        findUnique: vi.fn(),
      },
    };
    const program = createReferralProgram({
      refereeDiscountValue: new Decimal(10000),
      maxCreditsPerBookingAmount: new Decimal(30000),
    });
    referralProgramService = {
      getActiveProgram: vi.fn().mockResolvedValue(program),
      getProgram: vi.fn().mockResolvedValue(program),
      calculateRefereeDiscount: vi.fn().mockReturnValue(new Decimal(10000)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralApiService,
        {
          provide: DatabaseService,
          useValue: mockDatabaseService,
        },
        {
          provide: ReferralProgramService,
          useValue: referralProgramService,
        },
      ],
    }).compile();

    service = module.get<ReferralApiService>(ReferralApiService);
  });

  it("throws not-found exception for invalid referral code", async () => {
    mockDatabaseService.user.findUnique.mockResolvedValue(null);

    await expect(service.validateReferralCode("ABCDEFGH", "")).rejects.toThrow(
      ReferralInvalidCodeException,
    );
  });

  it("throws when the programme is inactive", async () => {
    referralProgramService.getActiveProgram.mockResolvedValue(null);

    await expect(service.validateReferralCode("ABCDEFGH", "")).rejects.toThrow(
      ReferralProgramInactiveException,
    );
    expect(mockDatabaseService.user.findUnique).not.toHaveBeenCalled();
  });

  it("throws self-referral exception when email matches referrer", async () => {
    mockDatabaseService.user.findUnique.mockResolvedValue({
      id: "user-1",
      name: "Referrer",
      email: "referrer@example.com",
      referralCode: "ABCDEFGH",
    });

    await expect(service.validateReferralCode("ABCDEFGH", "referrer@example.com")).rejects.toThrow(
      ReferralSelfReferralException,
    );
  });

  it("returns eligibility false when user has reserved or rewarded referral booking", async () => {
    mockDatabaseService.user.findUnique.mockResolvedValue({
      referredByUserId: "referrer-1",
      referralDiscountUsed: false,
      referralSignupAt: new Date(),
    });
    mockDatabaseService.booking.findFirst.mockResolvedValue({
      id: "booking-1",
      referralStatus: BookingReferralStatus.RESERVED,
    });

    const result = await service.checkReferralEligibility("user-1", 30000, "DAY");

    expect(result).toEqual({
      eligible: false,
      reason: "Referral discount already reserved or used",
      discountAmount: 0,
    });
  });

  it("maps user referral summary payload with shareLink and numeric fields", async () => {
    mockDatabaseService.user.findUnique.mockResolvedValueOnce({
      referralCode: "ABCDEFGH",
      referredByUserId: null,
      referralDiscountUsed: false,
      referralSignupAt: null,
      _count: { referrals: 1 },
      referrals: [
        {
          id: "user-2",
          name: "New User",
          email: "new@example.com",
          createdAt: new Date("2030-01-01T00:00:00.000Z"),
        },
      ],
      referralRewardsEarned: [
        {
          id: "reward-1",
          amount: { toNumber: () => 1500 },
          status: "RELEASED",
          createdAt: new Date("2030-01-02T00:00:00.000Z"),
          processedAt: new Date("2030-01-03T00:00:00.000Z"),
          referee: {
            name: "Referee Name",
            email: "referee@example.com",
          },
        },
      ],
    });
    mockDatabaseService.referralReward.aggregate
      .mockResolvedValueOnce({
        _sum: { amount: { toNumber: () => 2500 } },
      })
      .mockResolvedValueOnce({
        _sum: { amount: { toNumber: () => 500 } },
      });
    mockDatabaseService.booking.aggregate
      .mockResolvedValueOnce({
        _sum: { referralCreditsUsed: { toNumber: () => 500 } },
      })
      .mockResolvedValueOnce({
        _sum: { referralCreditsReserved: { toNumber: () => 300 } },
      });

    const result = await service.getUserReferralSummary("user-1", "http://localhost:3000");
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.referralCode).toBe("ABCDEFGH");
    expect(result.shareLink).toBe("http://localhost:3000/auth?ref=ABCDEFGH");
    expect(result.programEnabled).toBe(true);
    expect(result.discountAmount).toBe(10000);
    expect(result.discount).toEqual({ type: ReferralIncentiveType.FIXED, amount: 10000 });
    expect(result.stats.totalReferrals).toBe(1);
    expect(result.stats.totalRewardsGranted).toBe(2500);
    expect(result.stats.totalRewardsPending).toBe(500);
    expect(result.stats.totalEarned).toBe(2500);
    expect(result.stats.totalUsed).toBe(500);
    expect(result.stats.availableCredits).toBe(1700);
    expect(result.rewards[0]?.amount).toBe(1500);
    expect(result.rewards[0]?.refereeName).toBe("Referee Name");
  });

  it("derives summary stats from source rows when denormalized stats drift", async () => {
    mockDatabaseService.user.findUnique.mockResolvedValueOnce({
      referralCode: "ABCDEFGH",
      referredByUserId: null,
      referralDiscountUsed: false,
      referralSignupAt: null,
      _count: { referrals: 1 },
      referrals: [
        {
          id: "referee-1",
          name: null,
          email: "referee@tripdly.com",
          createdAt: new Date("2030-01-01T00:00:00.000Z"),
        },
      ],
      referralRewardsEarned: [
        {
          id: "reward-1",
          amount: { toNumber: () => 10000 },
          status: "PENDING",
          createdAt: new Date("2030-01-02T00:00:00.000Z"),
          processedAt: null,
          referee: {
            name: null,
            email: "referee@tripdly.com",
          },
        },
      ],
    });
    mockDatabaseService.referralReward.aggregate
      .mockResolvedValueOnce({
        _sum: { amount: null },
      })
      .mockResolvedValueOnce({
        _sum: { amount: { toNumber: () => 10000 } },
      });
    mockDatabaseService.booking.aggregate
      .mockResolvedValueOnce({
        _sum: { referralCreditsUsed: null },
      })
      .mockResolvedValueOnce({
        _sum: { referralCreditsReserved: null },
      });

    const result = await service.getUserReferralSummary("referrer-1", "http://localhost:3000");

    expect(result?.stats.totalReferrals).toBe(1);
    expect(result?.stats.totalRewardsGranted).toBe(0);
    expect(result?.stats.totalRewardsPending).toBe(10000);
    expect(result?.stats.totalEarned).toBe(0);
    expect(result?.stats.availableCredits).toBe(0);
    expect(mockDatabaseService.userReferralStats.findUnique).not.toHaveBeenCalled();
  });

  it("reports the programme as disabled when it is paused or missing", async () => {
    referralProgramService.getProgram.mockResolvedValue(
      createReferralProgram({ status: ReferralProgramStatus.PAUSED }),
    );
    mockDatabaseService.user.findUnique.mockResolvedValueOnce({
      referralCode: "ABCDEFGH",
      referredByUserId: null,
      referralDiscountUsed: false,
      referralSignupAt: null,
      _count: { referrals: 0 },
      referrals: [],
      referralRewardsEarned: [],
    });
    mockDatabaseService.referralReward.aggregate
      .mockResolvedValue({ _sum: { amount: null } })
      .mockResolvedValue({ _sum: { amount: null } });
    mockDatabaseService.booking.aggregate
      .mockResolvedValue({ _sum: { referralCreditsUsed: null } })
      .mockResolvedValue({ _sum: { referralCreditsReserved: null } });

    const result = await service.getUserReferralSummary("user-1", "http://localhost:3000");

    expect(result?.programEnabled).toBe(false);
  });
});
