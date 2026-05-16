import { Test, type TestingModule } from "@nestjs/testing";
import {
  BookingReferralStatus,
  BookingStatus,
  PaymentStatus,
  ReferralRewardStatus,
} from "@prisma/client";
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
    const result = await service.checkReferralEligibilityForPricing(
      null,
      new Decimal(50000),
      "DAY",
    );

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
      booking: { findFirst: vi.fn().mockResolvedValue(null) },
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
    const result = await service.checkReferralEligibilityForPricing(
      { id: "user-1" } as never,
      new Decimal(25000),
      "DAY",
    );

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
      service.verifyAndReserveReferralDiscountInTransaction(
        {
          $queryRaw: vi
            .fn()
            .mockResolvedValue([
              { id: "user-1", referredByUserId: "referrer-1", referralDiscountUsed: true },
            ]),
          booking: { findFirst: vi.fn() },
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
      booking: { findFirst: vi.fn().mockResolvedValue(null) },
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
    const result = await service.checkReferralEligibilityForPricing(
      { id: "user-1" } as never,
      new Decimal(25000),
      "DAY",
    );

    expect(result).toEqual({
      eligible: false,
      referrerUserId: null,
      discountAmount: new Decimal(0),
    });
  });

  it("reserves eligibility without marking the discount used before payment", async () => {
    const mockUserUpdate = vi.fn();
    const service = (
      await Test.createTestingModule({
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
        .compile()
    ).get<BookingEligibilityService>(BookingEligibilityService);

    const result = await service.verifyAndReserveReferralDiscountInTransaction(
      {
        $queryRaw: vi
          .fn()
          .mockResolvedValue([
            { id: "user-1", referredByUserId: "referrer-1", referralDiscountUsed: false },
          ]),
        booking: {
          findFirst: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
          updateMany: vi.fn(),
        },
        referralReward: { deleteMany: vi.fn() },
        user: { update: mockUserUpdate },
      } as never,
      "user-1",
      {
        eligible: true,
        referrerUserId: "referrer-1",
        discountAmount: new Decimal(5000),
      },
    );

    expect(result).toEqual({
      eligible: true,
      referrerUserId: "referrer-1",
      discountAmount: new Decimal(5000),
    });
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("returns pricing eligibility when referred user meets amount and booking type rules", async () => {
    const databaseService = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            createUser({ referredByUserId: "referrer-1", referralDiscountUsed: false }),
          ),
      },
      booking: { findFirst: vi.fn().mockResolvedValue(null) },
      referralProgramConfig: {
        findMany: vi.fn().mockResolvedValue([
          { key: "REFERRAL_ENABLED", value: true },
          { key: "REFERRAL_DISCOUNT_AMOUNT", value: "5000" },
          { key: "REFERRAL_MIN_BOOKING_AMOUNT", value: "20000" },
          { key: "REFERRAL_ELIGIBLE_TYPES", value: ["DAY", "FULL_DAY"] },
          { key: "REFERRAL_EXPIRY_DAYS", value: 30 },
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
    const result = await service.checkReferralEligibilityForPricing(
      { id: "user-1" } as never,
      new Decimal(52500),
      "DAY",
    );

    expect(result).toEqual({
      eligible: true,
      referrerUserId: "referrer-1",
      discountAmount: new Decimal(5000),
    });
  });

  it("returns ineligible for pricing when another active booking reserved the discount", async () => {
    const databaseService = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            createUser({ referredByUserId: "referrer-1", referralDiscountUsed: false }),
          ),
      },
      booking: { findFirst: vi.fn().mockResolvedValue({ id: "booking-1" }) },
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
    const result = await service.checkReferralEligibilityForPricing(
      { id: "user-1" } as never,
      new Decimal(52500),
      "DAY",
    );

    expect(result).toEqual({
      eligible: false,
      referrerUserId: null,
      discountAmount: new Decimal(0),
    });
    expect(databaseService.booking.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        status: {
          in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.ACTIVE],
        },
        OR: [
          {
            referralStatus: {
              in: [BookingReferralStatus.APPLIED, BookingReferralStatus.REWARDED],
            },
          },
          {
            referralStatus: BookingReferralStatus.RESERVED,
            paymentStatus: { not: PaymentStatus.UNPAID },
          },
        ],
      },
      select: { id: true },
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

  it("ignores stale RESERVED+PENDING+UNPAID bookings when checking pricing eligibility", async () => {
    const databaseService = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            createUser({ referredByUserId: "referrer-1", referralDiscountUsed: false }),
          ),
      },
      booking: { findFirst: vi.fn().mockResolvedValue(null) },
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
    const result = await service.checkReferralEligibilityForPricing(
      { id: "user-1" } as never,
      new Decimal(52500),
      "DAY",
    );

    expect(result).toEqual({
      eligible: true,
      referrerUserId: "referrer-1",
      discountAmount: new Decimal(5000),
    });
    // The OR branch covering RESERVED requires paymentStatus != UNPAID, so an abandoned
    // checkout (RESERVED + PENDING + UNPAID) doesn't match and the user stays eligible.
    expect(databaseService.booking.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        status: {
          in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.ACTIVE],
        },
        OR: [
          {
            referralStatus: {
              in: [BookingReferralStatus.APPLIED, BookingReferralStatus.REWARDED],
            },
          },
          {
            referralStatus: BookingReferralStatus.RESERVED,
            paymentStatus: { not: PaymentStatus.UNPAID },
          },
        ],
      },
      select: { id: true },
    });
  });

  describe("releaseReferralReservation", () => {
    const buildService = async () => {
      const module = await Test.createTestingModule({
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
      return module.get<BookingEligibilityService>(BookingEligibilityService);
    };

    it("clears the reservation and deletes pending reward when the conditional update affects a row", async () => {
      const service = await buildService();
      const bookingUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const rewardDeleteMany = vi.fn().mockResolvedValue({ count: 1 });

      const result = await service.releaseReferralReservation(
        {
          booking: { updateMany: bookingUpdateMany },
          referralReward: { deleteMany: rewardDeleteMany },
        } as never,
        "booking-1",
      );

      expect(result).toEqual({ released: true });
      expect(bookingUpdateMany).toHaveBeenCalledWith({
        where: {
          id: "booking-1",
          referralStatus: BookingReferralStatus.RESERVED,
          status: BookingStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
        },
        data: {
          referralStatus: BookingReferralStatus.REVERSED,
          referralDiscountAmount: new Decimal(0),
          referralReferrerUserId: null,
        },
      });
      expect(rewardDeleteMany).toHaveBeenCalledWith({
        where: {
          bookingId: "booking-1",
          status: ReferralRewardStatus.PENDING,
        },
      });
    });

    // The atomic updateMany returns count: 0 in all "not releasable" scenarios —
    // missing booking, already APPLIED/REWARDED, or RESERVED+mid-payment — because
    // the state predicates live in the WHERE clause. We can't distinguish those
    // scenarios at the unit level without a real DB; the E2E test in
    // booking-flow.e2e-spec.ts asserts on the actual states.
    it("is a no-op when the conditional update affects zero rows", async () => {
      const service = await buildService();
      const bookingUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
      const rewardDeleteMany = vi.fn();

      const result = await service.releaseReferralReservation(
        {
          booking: { updateMany: bookingUpdateMany },
          referralReward: { deleteMany: rewardDeleteMany },
        } as never,
        "booking-1",
      );

      expect(result).toEqual({ released: false });
      expect(rewardDeleteMany).not.toHaveBeenCalled();
    });
  });

  it("releases stale reservations before reserving a new discount", async () => {
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

    const bookingFindMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: "stale-booking-1" }, { id: "stale-booking-2" }]);
    const bookingUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const rewardDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const bookingFindFirst = vi.fn().mockResolvedValue(null);

    const result = await service.verifyAndReserveReferralDiscountInTransaction(
      {
        $queryRaw: vi
          .fn()
          .mockResolvedValue([
            { id: "user-1", referredByUserId: "referrer-1", referralDiscountUsed: false },
          ]),
        booking: {
          findMany: bookingFindMany,
          findFirst: bookingFindFirst,
          updateMany: bookingUpdateMany,
        },
        referralReward: { deleteMany: rewardDeleteMany },
        user: { update: vi.fn() },
      } as never,
      "user-1",
      {
        eligible: true,
        referrerUserId: "referrer-1",
        discountAmount: new Decimal(5000),
      },
    );

    expect(result).toEqual({
      eligible: true,
      referrerUserId: "referrer-1",
      discountAmount: new Decimal(5000),
    });
    expect(bookingFindMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        referralStatus: BookingReferralStatus.RESERVED,
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
      },
      select: { id: true },
    });
    expect(bookingUpdateMany).toHaveBeenCalledTimes(2);
    const expectedUpdateData = {
      referralStatus: BookingReferralStatus.REVERSED,
      referralDiscountAmount: new Decimal(0),
      referralReferrerUserId: null,
    };
    expect(bookingUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "stale-booking-1",
        referralStatus: BookingReferralStatus.RESERVED,
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
      },
      data: expectedUpdateData,
    });
    expect(bookingUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "stale-booking-2",
        referralStatus: BookingReferralStatus.RESERVED,
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
      },
      data: expectedUpdateData,
    });
  });

  it("still throws when an in-flight (PAID) reservation blocks reuse after stale release", async () => {
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
      service.verifyAndReserveReferralDiscountInTransaction(
        {
          $queryRaw: vi
            .fn()
            .mockResolvedValue([
              { id: "user-1", referredByUserId: "referrer-1", referralDiscountUsed: false },
            ]),
          booking: {
            findMany: vi.fn().mockResolvedValue([]),
            findFirst: vi.fn().mockResolvedValue({ id: "in-flight-booking" }),
            updateMany: vi.fn(),
          },
          referralReward: { deleteMany: vi.fn() },
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
});
