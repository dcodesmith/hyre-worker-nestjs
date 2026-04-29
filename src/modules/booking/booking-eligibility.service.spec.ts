import { Test, type TestingModule } from "@nestjs/testing";
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createUser } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { ReferralDiscountNoLongerAvailableException } from "./booking.error";
import { BookingEligibilityService } from "./booking-eligibility.service";

describe("BookingEligibilityService", () => {
  it("returns ineligible for guests", async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingEligibilityService,
        {
          provide: DatabaseService,
          useValue: {
            user: { findUnique: vi.fn() },
            referralProgramConfig: { findMany: vi.fn() },
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    const service = module.get<BookingEligibilityService>(BookingEligibilityService);
    const result = await service.checkPreliminaryReferralEligibility(null);

    expect(result).toEqual({
      eligible: false,
      referrerUserId: null,
      discountAmount: new Decimal(0),
    });
  });

  it("returns eligible with configured discount when user is referred", async () => {
    const databaseService = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            createUser({ referredByUserId: "referrer-1", referralDiscountUsed: false }),
          ),
      },
      referralProgramConfig: {
        findMany: vi.fn().mockResolvedValue([
          { key: "REFERRAL_ENABLED", value: true },
          { key: "REFERRAL_DISCOUNT_AMOUNT", value: "5000" },
        ]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingEligibilityService,
        { provide: DatabaseService, useValue: databaseService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    const service = module.get<BookingEligibilityService>(BookingEligibilityService);
    const result = await service.checkPreliminaryReferralEligibility({
      id: "user-1",
    } as never);

    expect(result).toEqual({
      eligible: true,
      referrerUserId: "referrer-1",
      discountAmount: new Decimal(5000),
    });
  });

  it("throws when discount was already claimed by concurrent transaction", async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingEligibilityService,
        {
          provide: DatabaseService,
          useValue: {
            user: { findUnique: vi.fn() },
            referralProgramConfig: { findMany: vi.fn() },
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    const service = module.get<BookingEligibilityService>(BookingEligibilityService);

    await expect(
      service.verifyAndClaimReferralDiscountInTransaction(
        {
          $queryRaw: vi
            .fn()
            .mockResolvedValue([
              { id: "user-1", referredByUserId: "referrer-1", referralDiscountUsed: true },
            ]),
          user: { update: vi.fn() },
        } as never,
        "user-1",
        {
          eligible: true,
          referrerUserId: "referrer-1",
          discountAmount: new Decimal(5000),
        },
      ),
    ).rejects.toThrow(ReferralDiscountNoLongerAvailableException);
  });

  it("treats non-finite discount config values as zero", async () => {
    const databaseService = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            createUser({ referredByUserId: "referrer-1", referralDiscountUsed: false }),
          ),
      },
      referralProgramConfig: {
        findMany: vi.fn().mockResolvedValue([
          { key: "REFERRAL_ENABLED", value: true },
          { key: "REFERRAL_DISCOUNT_AMOUNT", value: "1e999" },
        ]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingEligibilityService,
        { provide: DatabaseService, useValue: databaseService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    const service = module.get<BookingEligibilityService>(BookingEligibilityService);
    const result = await service.checkPreliminaryReferralEligibility({ id: "user-1" } as never);

    expect(result).toEqual({
      eligible: false,
      referrerUserId: null,
      discountAmount: new Decimal(0),
    });
  });

  it("increments totalReferrals when creating referral reward stats", async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingEligibilityService,
        {
          provide: DatabaseService,
          useValue: {
            user: { findUnique: vi.fn() },
            referralProgramConfig: { findMany: vi.fn() },
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    const service = module.get<BookingEligibilityService>(BookingEligibilityService);
    const rewardCreate = vi.fn().mockResolvedValue({});
    const statsUpsert = vi.fn().mockResolvedValue({});

    await service.createReferralRewardIfEligible(
      {
        referralProgramConfig: {
          findMany: vi.fn().mockResolvedValue([
            { key: "REFERRAL_REWARD_AMOUNT", value: "2500" },
            { key: "REFERRAL_RELEASE_CONDITION", value: "COMPLETED" },
          ]),
        },
        referralReward: { create: rewardCreate },
        userReferralStats: { upsert: statsUpsert },
      } as never,
      "booking-1",
      { eligible: true, referrerUserId: "referrer-1", discountAmount: new Decimal(5000) },
      "user-1",
    );

    expect(statsUpsert).toHaveBeenCalledWith({
      where: { userId: "referrer-1" },
      create: {
        userId: "referrer-1",
        totalReferrals: 1,
        totalRewardsGranted: 0,
        totalRewardsPending: new Decimal(2500),
      },
      update: {
        totalReferrals: { increment: 1 },
        totalRewardsPending: { increment: new Decimal(2500) },
      },
    });
  });
});
