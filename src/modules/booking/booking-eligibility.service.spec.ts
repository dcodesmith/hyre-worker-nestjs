import { Test, type TestingModule } from "@nestjs/testing";
import {
  BookingReferralStatus,
  BookingStatus,
  BookingType,
  PaymentStatus,
  ReferralIncentiveType,
  ReferralRewardStatus,
} from "@prisma/client";
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createReferralProgram, createUser } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { ReferralProgramService } from "../referral/referral-program.service";
import { ReferralDiscountNoLongerAvailableException } from "./booking.error";
import { BookingEligibilityService } from "./booking-eligibility.service";

const ineligible = {
  eligible: false,
  referrerUserId: null,
  discountAmount: new Decimal(0),
  rewardAmount: new Decimal(0),
};

const OWNER_ID = "owner-123";
const REFERRER_ID = "referrer-1";
const USER_ID = "user-1";

function queryRawSql(query: unknown): string {
  if (Array.isArray(query)) {
    return query.join("");
  }
  if (query && typeof query === "object" && "strings" in query) {
    return (query as { strings: string[] }).strings.join("");
  }
  return String(query);
}

function expectReferrerUserLockBeforeStats(
  queryRaw: ReturnType<typeof vi.fn>,
  statsWrite: ReturnType<typeof vi.fn>,
) {
  const lockIndex = queryRaw.mock.calls.findIndex(([query]) => {
    const sql = queryRawSql(query);
    return sql.includes('"User"') && sql.includes("FOR UPDATE");
  });
  expect(lockIndex).toBeGreaterThanOrEqual(0);
  expect(queryRaw.mock.calls[lockIndex]?.[1]).toBe(REFERRER_ID);
  expect(queryRaw.mock.invocationCallOrder[lockIndex]).toBeLessThan(
    statsWrite.mock.invocationCallOrder[0],
  );
}

async function createService(
  databaseService: Record<string, unknown>,
  programService?: Partial<ReferralProgramService>,
) {
  const calculator = new ReferralProgramService(
    { referralProgram: { findUnique: vi.fn() } } as never,
    { setContext: vi.fn() } as never,
  );
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      BookingEligibilityService,
      {
        provide: ReferralProgramService,
        useValue: {
          getActiveProgram: vi.fn().mockResolvedValue(null),
          getProgram: vi.fn().mockResolvedValue(null),
          getActiveProgramForTransaction: vi.fn().mockResolvedValue(null),
          getProgramForTransaction: vi.fn().mockResolvedValue(null),
          calculateRefereeDiscount: calculator.calculateRefereeDiscount.bind(calculator),
          calculateReferrerReward: calculator.calculateReferrerReward.bind(calculator),
          calculateCreditsCap: calculator.calculateCreditsCap.bind(calculator),
          ...programService,
        },
      },
      { provide: DatabaseService, useValue: databaseService },
    ],
  })
    .useMocker(mockPinoLoggerToken)
    .compile();

  return module.get(BookingEligibilityService);
}

describe("BookingEligibilityService", () => {
  describe("checkReferralEligibilityForPricing", () => {
    it("returns ineligible for guests", async () => {
      const service = await createService({ user: { findUnique: vi.fn() } });

      await expect(
        service.checkReferralEligibilityForPricing(null, new Decimal(50000), "DAY", OWNER_ID),
      ).resolves.toEqual(ineligible);
    });

    it("fails closed when the programme is missing", async () => {
      const service = await createService({
        user: {
          findUnique: vi
            .fn()
            .mockResolvedValue(
              createUser({ referredByUserId: REFERRER_ID, referralDiscountUsed: false }),
            ),
        },
      });

      await expect(
        service.checkReferralEligibilityForPricing(
          { id: USER_ID } as never,
          new Decimal(50000),
          "DAY",
          OWNER_ID,
        ),
      ).resolves.toEqual(ineligible);
    });

    it("fails closed when the programme is paused", async () => {
      const service = await createService(
        {
          user: {
            findUnique: vi
              .fn()
              .mockResolvedValue(
                createUser({ referredByUserId: REFERRER_ID, referralDiscountUsed: false }),
              ),
          },
        },
        { getActiveProgram: vi.fn().mockResolvedValue(null) },
      );

      await expect(
        service.checkReferralEligibilityForPricing(
          { id: USER_ID } as never,
          new Decimal(50000),
          "DAY",
          OWNER_ID,
        ),
      ).resolves.toEqual(ineligible);
    });

    it("excludes own-supply when the referrer owns the car", async () => {
      const program = createReferralProgram();
      const service = await createService(
        {
          user: {
            findUnique: vi
              .fn()
              .mockResolvedValue(
                createUser({ referredByUserId: OWNER_ID, referralDiscountUsed: false }),
              ),
          },
          booking: { findFirst: vi.fn().mockResolvedValue(null) },
        },
        { getActiveProgram: vi.fn().mockResolvedValue(program) },
      );

      await expect(
        service.checkReferralEligibilityForPricing(
          { id: USER_ID } as never,
          new Decimal(50000),
          "DAY",
          OWNER_ID,
        ),
      ).resolves.toEqual(ineligible);
    });

    it("excludes own-supply when the referee owns the car", async () => {
      const program = createReferralProgram();
      const service = await createService(
        {
          user: {
            findUnique: vi
              .fn()
              .mockResolvedValue(
                createUser({ referredByUserId: REFERRER_ID, referralDiscountUsed: false }),
              ),
          },
          booking: { findFirst: vi.fn().mockResolvedValue(null) },
        },
        { getActiveProgram: vi.fn().mockResolvedValue(program) },
      );

      await expect(
        service.checkReferralEligibilityForPricing(
          { id: OWNER_ID } as never,
          new Decimal(50000),
          "DAY",
          OWNER_ID,
        ),
      ).resolves.toEqual(ineligible);
    });

    it("calculates FIXED discount and reward from the active programme", async () => {
      const program = createReferralProgram();
      const service = await createService(
        {
          user: {
            findUnique: vi
              .fn()
              .mockResolvedValue(
                createUser({ referredByUserId: REFERRER_ID, referralDiscountUsed: false }),
              ),
          },
          booking: { findFirst: vi.fn().mockResolvedValue(null) },
        },
        { getActiveProgram: vi.fn().mockResolvedValue(program) },
      );

      await expect(
        service.checkReferralEligibilityForPricing(
          { id: USER_ID } as never,
          new Decimal(52500),
          "DAY",
          OWNER_ID,
        ),
      ).resolves.toEqual({
        eligible: true,
        referrerUserId: REFERRER_ID,
        discountAmount: new Decimal(5000),
        rewardAmount: new Decimal(2500),
      });
    });

    it("calculates PERCENTAGE discount and reward against the booking base", async () => {
      const program = createReferralProgram({
        refereeDiscountType: ReferralIncentiveType.PERCENTAGE,
        refereeDiscountValue: new Decimal(10),
        refereeDiscountMaxAmount: new Decimal(8000),
        referrerRewardType: ReferralIncentiveType.PERCENTAGE,
        referrerRewardValue: new Decimal(5),
        referrerRewardMaxAmount: new Decimal(4000),
      });
      const service = await createService(
        {
          user: {
            findUnique: vi
              .fn()
              .mockResolvedValue(
                createUser({ referredByUserId: REFERRER_ID, referralDiscountUsed: false }),
              ),
          },
          booking: { findFirst: vi.fn().mockResolvedValue(null) },
        },
        { getActiveProgram: vi.fn().mockResolvedValue(program) },
      );

      await expect(
        service.checkReferralEligibilityForPricing(
          { id: USER_ID } as never,
          new Decimal(50000),
          "DAY",
          OWNER_ID,
        ),
      ).resolves.toEqual({
        eligible: true,
        referrerUserId: REFERRER_ID,
        discountAmount: new Decimal(5000),
        rewardAmount: new Decimal(2500),
      });
    });

    it("returns ineligible when another active booking already claimed the discount", async () => {
      const program = createReferralProgram();
      const databaseService = {
        user: {
          findUnique: vi
            .fn()
            .mockResolvedValue(
              createUser({ referredByUserId: REFERRER_ID, referralDiscountUsed: false }),
            ),
        },
        booking: { findFirst: vi.fn().mockResolvedValue({ id: "booking-1" }) },
      };
      const service = await createService(databaseService, {
        getActiveProgram: vi.fn().mockResolvedValue(program),
      });

      await expect(
        service.checkReferralEligibilityForPricing(
          { id: USER_ID } as never,
          new Decimal(52500),
          "DAY",
          OWNER_ID,
        ),
      ).resolves.toEqual(ineligible);
      expect(databaseService.booking.findFirst).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
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
  });

  describe("credit caps", () => {
    it("returns zero credits when the programme is unconfigured", async () => {
      const service = await createService({
        referralReward: { aggregate: vi.fn() },
        $queryRaw: vi.fn(),
      });

      await expect(
        service.getReferralCreditBalanceForPricing(
          { id: USER_ID } as never,
          5000,
          new Decimal(100000),
        ),
      ).resolves.toEqual(new Decimal(0));
    });

    it("keeps used credits committed through refund processing and failure", async () => {
      const program = createReferralProgram();
      const queryRaw = vi.fn().mockResolvedValue([{ amount: new Decimal(0) }]);
      const service = await createService(
        {
          referralReward: {
            aggregate: vi.fn().mockResolvedValue({ _sum: { amount: new Decimal(10000) } }),
          },
          $queryRaw: queryRaw,
        },
        { getProgram: vi.fn().mockResolvedValue(program) },
      );

      await service.getReferralCreditBalanceForPricing(
        { id: USER_ID } as never,
        1000,
        new Decimal(50000),
      );

      const query = queryRaw.mock.calls[0]?.[0];
      const sql = Array.isArray(query)
        ? query.join("")
        : String(
            query && typeof query === "object" && "strings" in query
              ? (query as { strings: string[] }).strings.join("")
              : query,
          );
      expect(sql).toContain("REFUND_PROCESSING");
      expect(sql).toContain("REFUND_FAILED");
      expect(sql).toContain('"referralCreditsUsed"');
      expect(sql).toContain('"referralCreditsReserved"');
      expect(sql).not.toContain("'REFUNDED'");
    });

    it("caps available credits at the lower of amount and percentage limits", async () => {
      const program = createReferralProgram({
        maxCreditsPerBookingAmount: new Decimal(30000),
        maxCreditsPerBookingPercent: new Decimal(50),
      });
      const databaseService = {
        referralReward: {
          aggregate: vi.fn().mockResolvedValue({ _sum: { amount: new Decimal(50000) } }),
        },
        $queryRaw: vi.fn().mockResolvedValue([{ amount: new Decimal(10000) }]),
      };
      const service = await createService(databaseService, {
        getProgram: vi.fn().mockResolvedValue(program),
      });

      // available = 40000, amount cap 30000, 50% of 40000 = 20000 → 20000
      await expect(
        service.getReferralCreditBalanceForPricing(
          { id: USER_ID } as never,
          5000,
          new Decimal(40000),
        ),
      ).resolves.toEqual(new Decimal(20000));
    });

    it("locks the user before reading referral credits for reservation", async () => {
      const program = createReferralProgram({
        maxCreditsPerBookingAmount: new Decimal(50000),
        maxCreditsPerBookingPercent: new Decimal(100),
      });
      const queryRaw = vi
        .fn()
        .mockResolvedValueOnce([{ id: USER_ID }])
        .mockResolvedValueOnce([{ amount: new Decimal(12000) }]);
      const tx = {
        $queryRaw: queryRaw,
        referralReward: {
          aggregate: vi.fn().mockResolvedValue({ _sum: { amount: new Decimal(40000) } }),
        },
      };
      const service = await createService(
        { user: { findUnique: vi.fn() } },
        { getProgramForTransaction: vi.fn().mockResolvedValue(program) },
      );

      await expect(
        service.verifyReferralCreditBalanceInTransaction(
          tx as never,
          USER_ID,
          5000,
          new Decimal(80000),
        ),
      ).resolves.toEqual(new Decimal(28000));
      expect(queryRaw).toHaveBeenCalledTimes(2);
    });
  });

  describe("verifyAndReserveReferralDiscountInTransaction", () => {
    const preliminary = {
      eligible: true,
      referrerUserId: REFERRER_ID,
      discountAmount: new Decimal(5000),
      rewardAmount: new Decimal(2500),
    };

    it("throws when the transactional programme re-read finds no active programme", async () => {
      const service = await createService({ user: { findUnique: vi.fn() } });

      await expect(
        service.verifyAndReserveReferralDiscountInTransaction(
          { $queryRaw: vi.fn() } as never,
          USER_ID,
          preliminary,
          new Decimal(50000),
          BookingType.DAY,
          OWNER_ID,
        ),
      ).rejects.toThrow(ReferralDiscountNoLongerAvailableException);
    });

    it("throws when discount was already claimed by a concurrent transaction", async () => {
      const program = createReferralProgram();
      const service = await createService(
        { user: { findUnique: vi.fn() } },
        { getActiveProgramForTransaction: vi.fn().mockResolvedValue(program) },
      );

      await expect(
        service.verifyAndReserveReferralDiscountInTransaction(
          {
            $queryRaw: vi
              .fn()
              .mockResolvedValue([
                { id: USER_ID, referredByUserId: REFERRER_ID, referralDiscountUsed: true },
              ]),
          } as never,
          USER_ID,
          preliminary,
          new Decimal(50000),
          BookingType.DAY,
          OWNER_ID,
        ),
      ).rejects.toThrow(ReferralDiscountNoLongerAvailableException);
    });

    it("recalculates discount and reward from the locked programme snapshot", async () => {
      const program = createReferralProgram();
      const service = await createService(
        { user: { findUnique: vi.fn() } },
        { getActiveProgramForTransaction: vi.fn().mockResolvedValue(program) },
      );
      const mockUserUpdate = vi.fn();

      const result = await service.verifyAndReserveReferralDiscountInTransaction(
        {
          $queryRaw: vi.fn().mockResolvedValue([
            {
              id: USER_ID,
              referredByUserId: REFERRER_ID,
              referralDiscountUsed: false,
              referralSignupAt: null,
            },
          ]),
          booking: {
            findFirst: vi.fn().mockResolvedValue(null),
            findMany: vi.fn().mockResolvedValue([]),
            updateMany: vi.fn(),
          },
          referralReward: { updateManyAndReturn: vi.fn() },
          userReferralStats: { findUnique: vi.fn(), update: vi.fn() },
          user: { update: mockUserUpdate },
        } as never,
        USER_ID,
        preliminary,
        new Decimal(50000),
        BookingType.DAY,
        OWNER_ID,
      );

      expect(result).toEqual({
        eligible: true,
        referrerUserId: REFERRER_ID,
        discountAmount: new Decimal(5000),
        rewardAmount: new Decimal(2500),
      });
      expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it("releases stale reservations before reserving a new discount", async () => {
      const program = createReferralProgram();
      const service = await createService(
        { user: { findUnique: vi.fn() } },
        { getActiveProgramForTransaction: vi.fn().mockResolvedValue(program) },
      );
      const bookingFindMany = vi
        .fn()
        .mockResolvedValueOnce([{ id: "stale-booking-1" }, { id: "stale-booking-2" }]);
      const bookingUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const rewardUpdateManyAndReturn = vi.fn().mockResolvedValue([]);

      const result = await service.verifyAndReserveReferralDiscountInTransaction(
        {
          $queryRaw: vi.fn().mockResolvedValue([
            {
              id: USER_ID,
              referredByUserId: REFERRER_ID,
              referralDiscountUsed: false,
              referralSignupAt: null,
            },
          ]),
          booking: {
            findMany: bookingFindMany,
            findFirst: vi.fn().mockResolvedValue(null),
            updateMany: bookingUpdateMany,
          },
          referralReward: { updateManyAndReturn: rewardUpdateManyAndReturn },
          userReferralStats: { findUnique: vi.fn(), update: vi.fn() },
          user: { update: vi.fn() },
        } as never,
        USER_ID,
        preliminary,
        new Decimal(50000),
        BookingType.DAY,
        OWNER_ID,
      );

      expect(result.eligible).toBe(true);
      expect(bookingUpdateMany).toHaveBeenCalledTimes(2);
    });

    it("still throws when an in-flight reservation blocks reuse after stale release", async () => {
      const program = createReferralProgram();
      const service = await createService(
        { user: { findUnique: vi.fn() } },
        { getActiveProgramForTransaction: vi.fn().mockResolvedValue(program) },
      );

      await expect(
        service.verifyAndReserveReferralDiscountInTransaction(
          {
            $queryRaw: vi.fn().mockResolvedValue([
              {
                id: USER_ID,
                referredByUserId: REFERRER_ID,
                referralDiscountUsed: false,
                referralSignupAt: null,
              },
            ]),
            booking: {
              findMany: vi.fn().mockResolvedValue([]),
              findFirst: vi.fn().mockResolvedValue({ id: "in-flight-booking" }),
              updateMany: vi.fn(),
            },
          } as never,
          USER_ID,
          preliminary,
          new Decimal(50000),
          BookingType.DAY,
          OWNER_ID,
        ),
      ).rejects.toThrow(ReferralDiscountNoLongerAvailableException);
    });
  });

  describe("createReferralRewardIfEligible", () => {
    it("snapshots the eligibility reward amount onto the pending reward", async () => {
      const service = await createService({ user: { findUnique: vi.fn() } });
      const queryRaw = vi.fn().mockResolvedValue([{ id: REFERRER_ID }]);
      const rewardCreate = vi.fn().mockResolvedValue({});
      const statsUpsert = vi.fn().mockResolvedValue({});

      await service.createReferralRewardIfEligible(
        {
          $queryRaw: queryRaw,
          referralReward: { create: rewardCreate },
          userReferralStats: { upsert: statsUpsert },
        } as never,
        "booking-1",
        {
          eligible: true,
          referrerUserId: REFERRER_ID,
          discountAmount: new Decimal(5000),
          rewardAmount: new Decimal(2500),
        },
        USER_ID,
      );

      expect(rewardCreate).toHaveBeenCalledWith({
        data: {
          referrer: { connect: { id: REFERRER_ID } },
          referee: { connect: { id: USER_ID } },
          booking: { connect: { id: "booking-1" } },
          amount: new Decimal(2500),
          status: ReferralRewardStatus.PENDING,
        },
      });
      expect(statsUpsert).toHaveBeenCalledWith({
        where: { userId: REFERRER_ID },
        create: {
          userId: REFERRER_ID,
          totalReferrals: 1,
          totalRewardsGranted: 0,
          totalRewardsPending: new Decimal(2500),
        },
        update: {
          totalReferrals: { increment: 1 },
          totalRewardsPending: { increment: new Decimal(2500) },
        },
      });
      expectReferrerUserLockBeforeStats(queryRaw, statsUpsert);
    });

    it("does not create a reward when the snapshotted amount is zero", async () => {
      const service = await createService({ user: { findUnique: vi.fn() } });
      const rewardCreate = vi.fn();

      await service.createReferralRewardIfEligible(
        {
          referralReward: { create: rewardCreate },
          userReferralStats: { upsert: vi.fn() },
        } as never,
        "booking-1",
        {
          eligible: true,
          referrerUserId: REFERRER_ID,
          discountAmount: new Decimal(5000),
          rewardAmount: new Decimal(0),
        },
        USER_ID,
      );

      expect(rewardCreate).not.toHaveBeenCalled();
    });
  });

  describe("reverseReferralRewardForRefund", () => {
    it("reverses a PENDING reward with BOOKING_REFUNDED", async () => {
      const service = await createService({ user: { findUnique: vi.fn() } });
      const rewardUpdateManyAndReturn = vi
        .fn()
        .mockResolvedValue([{ referrerUserId: REFERRER_ID, amount: new Decimal(2500) }]);
      const statsFindUnique = vi.fn().mockResolvedValue({
        totalReferrals: 2,
        totalRewardsPending: new Decimal(2500),
      });
      const statsUpdate = vi.fn();
      const queryRaw = vi.fn().mockResolvedValue([
        {
          id: "reward-1",
          referrerUserId: REFERRER_ID,
          amount: new Decimal(2500),
          status: ReferralRewardStatus.PENDING,
        },
      ]);

      const result = await service.reverseReferralRewardForRefund(
        {
          $queryRaw: queryRaw,
          referralReward: { updateManyAndReturn: rewardUpdateManyAndReturn },
          userReferralStats: { findUnique: statsFindUnique, update: statsUpdate },
        } as never,
        "booking-1",
      );

      expect(result).toEqual({ reversed: true, manualRecoveryRequired: false });
      expectReferrerUserLockBeforeStats(queryRaw, statsUpdate);
      expect(rewardUpdateManyAndReturn).toHaveBeenCalledWith({
        where: { bookingId: "booking-1", status: ReferralRewardStatus.PENDING },
        data: {
          status: ReferralRewardStatus.REVERSED,
          processedAt: expect.any(Date),
          reason: "BOOKING_REFUNDED",
        },
        select: { referrerUserId: true, amount: true },
      });
    });

    it("reverses a RELEASED reward and is idempotent when already REVERSED", async () => {
      const service = await createService({ user: { findUnique: vi.fn() } });
      const queryRaw = vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: "reward-1",
            referrerUserId: REFERRER_ID,
            amount: new Decimal(2500),
            status: ReferralRewardStatus.RELEASED,
          },
        ])
        .mockResolvedValueOnce([{ id: REFERRER_ID }])
        .mockResolvedValueOnce([{ amount: new Decimal(0) }])
        .mockResolvedValueOnce([
          {
            id: "reward-1",
            referrerUserId: REFERRER_ID,
            amount: new Decimal(2500),
            status: ReferralRewardStatus.REVERSED,
          },
        ]);
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      const statsUpdate = vi.fn();

      const first = await service.reverseReferralRewardForRefund(
        {
          $queryRaw: queryRaw,
          referralReward: {
            aggregate: vi.fn().mockResolvedValue({ _sum: { amount: new Decimal(2500) } }),
            updateMany,
          },
          userReferralStats: {
            findUnique: vi.fn().mockResolvedValue({
              totalReferrals: 1,
              totalRewardsGranted: new Decimal(2500),
            }),
            update: statsUpdate,
          },
        } as never,
        "booking-1",
      );
      const second = await service.reverseReferralRewardForRefund(
        { $queryRaw: queryRaw } as never,
        "booking-1",
      );

      expect(first).toEqual({ reversed: true, manualRecoveryRequired: false });
      expect(second).toEqual({ reversed: false, manualRecoveryRequired: false });
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: "reward-1", status: ReferralRewardStatus.RELEASED },
        data: {
          status: ReferralRewardStatus.REVERSED,
          processedAt: expect.any(Date),
          reason: "BOOKING_REFUNDED",
        },
      });
      expect(statsUpdate).toHaveBeenCalledWith({
        where: { userId: REFERRER_ID },
        data: {
          totalReferrals: 0,
          totalRewardsGranted: new Decimal(0),
        },
      });
      expectReferrerUserLockBeforeStats(queryRaw, statsUpdate);
    });

    it("records a manual-recovery reason when released credits are already committed", async () => {
      const service = await createService({ user: { findUnique: vi.fn() } });
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });

      const result = await service.reverseReferralRewardForRefund(
        {
          $queryRaw: vi
            .fn()
            .mockResolvedValueOnce([
              {
                id: "reward-1",
                referrerUserId: REFERRER_ID,
                amount: new Decimal(5000),
                status: ReferralRewardStatus.RELEASED,
              },
            ])
            .mockResolvedValueOnce([{ id: REFERRER_ID }])
            .mockResolvedValueOnce([{ amount: new Decimal(4000) }]),
          referralReward: {
            aggregate: vi.fn().mockResolvedValue({ _sum: { amount: new Decimal(5000) } }),
            updateMany,
          },
          userReferralStats: {
            findUnique: vi.fn().mockResolvedValue({
              totalReferrals: 1,
              totalRewardsGranted: new Decimal(5000),
            }),
            update: vi.fn(),
          },
        } as never,
        "booking-1",
      );

      expect(result).toEqual({ reversed: true, manualRecoveryRequired: true });
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: "reward-1", status: ReferralRewardStatus.RELEASED },
        data: expect.objectContaining({
          reason: "BOOKING_REFUNDED_CREDITS_ALREADY_USED",
        }),
      });
    });
  });

  describe("releaseReferralReservation", () => {
    const buildTx = (
      overrides: {
        queryRaw?: ReturnType<typeof vi.fn>;
        bookingUpdateMany?: ReturnType<typeof vi.fn>;
        rewardUpdateManyAndReturn?: ReturnType<typeof vi.fn>;
        statsFindUnique?: ReturnType<typeof vi.fn>;
        statsUpdate?: ReturnType<typeof vi.fn>;
      } = {},
    ) => ({
      $queryRaw: overrides.queryRaw ?? vi.fn().mockResolvedValue([{ id: REFERRER_ID }]),
      booking: {
        updateMany: overrides.bookingUpdateMany ?? vi.fn().mockResolvedValue({ count: 1 }),
      },
      referralReward: {
        updateManyAndReturn: overrides.rewardUpdateManyAndReturn ?? vi.fn().mockResolvedValue([]),
      },
      userReferralStats: {
        findUnique: overrides.statsFindUnique ?? vi.fn(),
        update: overrides.statsUpdate ?? vi.fn(),
      },
    });

    it("flips the booking, soft-deletes the pending reward to REVERSED, and decrements referrer stats", async () => {
      const service = await createService({ user: { findUnique: vi.fn() } });
      const bookingUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const rewardUpdateManyAndReturn = vi
        .fn()
        .mockResolvedValue([{ referrerUserId: REFERRER_ID, amount: new Decimal(2500) }]);
      const statsFindUnique = vi.fn().mockResolvedValue({
        totalReferrals: 3,
        totalRewardsPending: new Decimal(7500),
      });
      const statsUpdate = vi.fn().mockResolvedValue({});
      const queryRaw = vi.fn().mockResolvedValue([{ id: REFERRER_ID }]);

      const result = await service.releaseReferralReservation(
        buildTx({
          queryRaw,
          bookingUpdateMany,
          rewardUpdateManyAndReturn,
          statsFindUnique,
          statsUpdate,
        }) as never,
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
      expect(statsUpdate).toHaveBeenCalledWith({
        where: { userId: REFERRER_ID },
        data: {
          totalReferrals: 2,
          totalRewardsPending: new Decimal(5000),
        },
      });
      expectReferrerUserLockBeforeStats(queryRaw, statsUpdate);
    });

    it("is a no-op when the conditional booking update affects zero rows", async () => {
      const service = await createService({ user: { findUnique: vi.fn() } });
      const rewardUpdateManyAndReturn = vi.fn();

      await expect(
        service.releaseReferralReservation(
          buildTx({
            bookingUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
            rewardUpdateManyAndReturn,
          }) as never,
          "booking-1",
        ),
      ).resolves.toEqual({ released: false });
      expect(rewardUpdateManyAndReturn).not.toHaveBeenCalled();
    });

    it("floors stats counters at zero when current values are lower than the decrement", async () => {
      const service = await createService({ user: { findUnique: vi.fn() } });
      const statsUpdate = vi.fn().mockResolvedValue({});

      await service.releaseReferralReservation(
        buildTx({
          rewardUpdateManyAndReturn: vi
            .fn()
            .mockResolvedValue([{ referrerUserId: REFERRER_ID, amount: new Decimal(5000) }]),
          statsFindUnique: vi.fn().mockResolvedValue({
            totalReferrals: 0,
            totalRewardsPending: new Decimal(1000),
          }),
          statsUpdate,
        }) as never,
        "booking-1",
      );

      expect(statsUpdate).toHaveBeenCalledWith({
        where: { userId: REFERRER_ID },
        data: {
          totalReferrals: 0,
          totalRewardsPending: new Decimal(0),
        },
      });
    });
  });
});
