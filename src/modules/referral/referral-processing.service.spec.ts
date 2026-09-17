import { Test, type TestingModule } from "@nestjs/testing";
import {
  BookingReferralStatus,
  BookingStatus,
  PaymentStatus,
  ReferralRewardStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { ReferralRewardReleasedHandler } from "../notification/handlers/referral-reward-released.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import { ReferralProcessingService } from "./referral-processing.service";

const BOOKING_ID = "booking-123";
const REFERRER_ID = "referrer-123";

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

function eligibleBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    userId: "user-123",
    status: BookingStatus.COMPLETED,
    paymentStatus: PaymentStatus.PAID,
    referralReferrerUserId: REFERRER_ID,
    referralStatus: BookingReferralStatus.APPLIED,
    deletedAt: null,
    ...overrides,
  };
}

function pendingReward(overrides: Record<string, unknown> = {}) {
  return {
    id: "reward-123",
    bookingId: BOOKING_ID,
    referrerUserId: REFERRER_ID,
    amount: 1000,
    status: ReferralRewardStatus.PENDING,
    ...overrides,
  };
}

describe("ReferralProcessingService", () => {
  let service: ReferralProcessingService;
  let notificationOutboxService: NotificationOutboxService;
  let databaseService: { $transaction: ReturnType<typeof vi.fn> };
  const transactionClient = {
    $queryRaw: vi.fn(),
    booking: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    referralReward: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    userReferralStats: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    databaseService = {
      $transaction: vi.fn((callback: (tx: typeof transactionClient) => Promise<unknown>) =>
        callback(transactionClient),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralProcessingService,
        {
          provide: DatabaseService,
          useValue: databaseService,
        },
        {
          provide: NotificationOutboxService,
          useValue: { create: vi.fn().mockResolvedValue(1) },
        },
        {
          provide: ReferralRewardReleasedHandler,
          useValue: { eventType: "BOOKING_LIFECYCLE", buildEvents: vi.fn() },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(ReferralProcessingService);
    notificationOutboxService = module.get(NotificationOutboxService);
    transactionClient.referralReward.updateMany.mockResolvedValue({ count: 1 });
    transactionClient.booking.update.mockResolvedValue({});
    transactionClient.user.update.mockResolvedValue({});
    transactionClient.userReferralStats.findUnique.mockResolvedValue(null);
    transactionClient.userReferralStats.upsert.mockResolvedValue({});
    transactionClient.user.findUnique.mockResolvedValue({
      referralDiscountUsed: false,
    });
  });

  it("releases only a COMPLETED + PAID + APPLIED booking with a PENDING reward", async () => {
    transactionClient.booking.findUnique.mockResolvedValue(eligibleBooking());
    transactionClient.referralReward.findUnique.mockResolvedValue(pendingReward());

    await expect(service.processReferralCompletionForBooking(BOOKING_ID)).resolves.toBe(true);

    expect(transactionClient.referralReward.updateMany).toHaveBeenCalledWith({
      where: {
        id: "reward-123",
        status: ReferralRewardStatus.PENDING,
      },
      data: {
        status: ReferralRewardStatus.RELEASED,
        processedAt: expect.any(Date),
      },
    });
    expect(transactionClient.booking.update).toHaveBeenCalledWith({
      where: { id: BOOKING_ID },
      data: { referralStatus: BookingReferralStatus.REWARDED },
    });
    expect(transactionClient.user.update).toHaveBeenCalledWith({
      where: { id: "user-123" },
      data: { referralDiscountUsed: true },
    });
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "BOOKING_LIFECYCLE" }),
      {
        rewardId: "reward-123",
        bookingId: BOOKING_ID,
        referrerUserId: REFERRER_ID,
        amount: 1000,
        releasedAt: expect.any(Date),
      },
      transactionClient,
    );
    expectReferrerUserLockBeforeStats(
      transactionClient.$queryRaw,
      transactionClient.userReferralStats.upsert,
    );
  });

  it("releases a COMPLETED + REFUND_FAILED + APPLIED pending reward on the provided transaction", async () => {
    transactionClient.booking.findUnique.mockResolvedValue(
      eligibleBooking({ paymentStatus: PaymentStatus.REFUND_FAILED }),
    );
    transactionClient.referralReward.findUnique.mockResolvedValue(pendingReward());

    await expect(
      service.processReferralCompletionAfterFailedRefund(transactionClient as never, BOOKING_ID),
    ).resolves.toBe(true);

    expect(databaseService.$transaction).not.toHaveBeenCalled();
    expect(transactionClient.referralReward.updateMany).toHaveBeenCalledWith({
      where: {
        id: "reward-123",
        status: ReferralRewardStatus.PENDING,
      },
      data: {
        status: ReferralRewardStatus.RELEASED,
        processedAt: expect.any(Date),
      },
    });
    expectReferrerUserLockBeforeStats(
      transactionClient.$queryRaw,
      transactionClient.userReferralStats.upsert,
    );
  });

  it("does not release a PAID booking through the failed-refund completion path", async () => {
    transactionClient.booking.findUnique.mockResolvedValue(eligibleBooking());
    transactionClient.referralReward.findUnique.mockResolvedValue(pendingReward());

    await expect(
      service.processReferralCompletionAfterFailedRefund(transactionClient as never, BOOKING_ID),
    ).resolves.toBe(false);

    expect(databaseService.$transaction).not.toHaveBeenCalled();
    expect(transactionClient.referralReward.updateMany).not.toHaveBeenCalled();
  });

  it("does not consult current programme status or expiry", async () => {
    transactionClient.booking.findUnique.mockResolvedValue(eligibleBooking());
    transactionClient.referralReward.findUnique.mockResolvedValue(pendingReward());

    await expect(service.processReferralCompletionForBooking(BOOKING_ID)).resolves.toBe(true);

    expect(transactionClient).not.toHaveProperty("referralProgram");
    expect(transactionClient.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-123" },
      select: { referralDiscountUsed: true },
    });
  });

  it.each([
    { name: "missing booking", booking: null },
    { name: "soft-deleted booking", booking: eligibleBooking({ deletedAt: new Date() }) },
    {
      name: "non-COMPLETED booking",
      booking: eligibleBooking({ status: BookingStatus.CONFIRMED }),
    },
    {
      name: "refunded booking",
      booking: eligibleBooking({ paymentStatus: PaymentStatus.REFUNDED }),
    },
    {
      name: "REFUND_FAILED booking",
      booking: eligibleBooking({ paymentStatus: PaymentStatus.REFUND_FAILED }),
    },
    {
      name: "non-APPLIED referral",
      booking: eligibleBooking({ referralStatus: BookingReferralStatus.RESERVED }),
    },
    { name: "missing user", booking: eligibleBooking({ userId: null }) },
    {
      name: "missing referrer",
      booking: eligibleBooking({ referralReferrerUserId: null }),
    },
  ])("does not release when $name", async ({ booking }) => {
    transactionClient.booking.findUnique.mockResolvedValue(booking);

    await expect(service.processReferralCompletionForBooking(BOOKING_ID)).resolves.toBe(false);
    expect(transactionClient.referralReward.updateMany).not.toHaveBeenCalled();
  });

  it("is idempotent when the reward is no longer PENDING", async () => {
    transactionClient.booking.findUnique.mockResolvedValue(eligibleBooking());
    transactionClient.referralReward.findUnique.mockResolvedValue(
      pendingReward({ status: ReferralRewardStatus.RELEASED }),
    );

    await expect(service.processReferralCompletionForBooking(BOOKING_ID)).resolves.toBe(false);
    expect(transactionClient.referralReward.updateMany).not.toHaveBeenCalled();
  });

  it("is idempotent when a concurrent worker already released the reward", async () => {
    transactionClient.booking.findUnique.mockResolvedValue(eligibleBooking());
    transactionClient.referralReward.findUnique.mockResolvedValue(pendingReward());
    transactionClient.referralReward.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.processReferralCompletionForBooking(BOOKING_ID)).resolves.toBe(false);
    expect(transactionClient.booking.update).not.toHaveBeenCalled();
  });

  it("does not mark the referee discount used when it is already marked", async () => {
    transactionClient.booking.findUnique.mockResolvedValue(eligibleBooking());
    transactionClient.referralReward.findUnique.mockResolvedValue(pendingReward());
    transactionClient.user.findUnique.mockResolvedValue({ referralDiscountUsed: true });

    await expect(service.processReferralCompletionForBooking(BOOKING_ID)).resolves.toBe(true);
    expect(transactionClient.user.update).not.toHaveBeenCalled();
  });

  it("clamps totalRewardsPending at zero when stats have drifted", async () => {
    transactionClient.booking.findUnique.mockResolvedValue(eligibleBooking());
    transactionClient.referralReward.findUnique.mockResolvedValue(pendingReward({ amount: 500 }));
    transactionClient.userReferralStats.findUnique.mockResolvedValue({
      totalRewardsPending: 100,
    });

    await service.processReferralCompletionForBooking(BOOKING_ID);

    const upsert = transactionClient.userReferralStats.upsert.mock.calls[0]?.[0];
    expect(upsert.update.totalRewardsPending.toString()).toBe("0");
  });

  it("rethrows transaction failures so the worker can retry", async () => {
    const databaseService = {
      $transaction: vi.fn(async () => {
        throw new Error("Database constraint violation");
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralProcessingService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: NotificationOutboxService, useValue: { create: vi.fn() } },
        {
          provide: ReferralRewardReleasedHandler,
          useValue: { eventType: "BOOKING_LIFECYCLE" },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    await expect(
      module.get(ReferralProcessingService).processReferralCompletionForBooking(BOOKING_ID),
    ).rejects.toThrow("Database constraint violation");
  });
});
