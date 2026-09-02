import { Test, TestingModule } from "@nestjs/testing";
import {
  BookingReferralStatus,
  ReferralReleaseCondition,
  ReferralRewardStatus,
} from "@prisma/client";
import { createBooking } from "src/shared/helper.fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { ReferralRewardReleasedHandler } from "../notification/handlers/referral-reward-released.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import { ReferralProcessingService } from "./referral-processing.service";

describe("ReferralProcessingService", () => {
  let service: ReferralProcessingService;
  let databaseService: DatabaseService;
  let notificationOutboxService: NotificationOutboxService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralProcessingService,
        {
          provide: DatabaseService,
          useValue: {
            referralProgramConfig: {
              findMany: vi.fn(),
            },
            booking: {
              findFirst: vi.fn(),
              update: vi.fn(),
            },
            user: {
              findUnique: vi.fn(),
              update: vi.fn(),
            },
            referralReward: {
              findFirst: vi.fn(),
              updateMany: vi.fn(),
            },
            $transaction: vi.fn(),
            userReferralStats: {
              findUnique: vi.fn(),
              upsert: vi.fn(),
            },
          },
        },
        {
          provide: NotificationOutboxService,
          useValue: {
            create: vi.fn().mockResolvedValue(1),
          },
        },
        {
          provide: ReferralRewardReleasedHandler,
          useValue: {
            eventType: "BOOKING_LIFECYCLE",
            buildEvents: vi.fn(),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<ReferralProcessingService>(ReferralProcessingService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    notificationOutboxService = module.get<NotificationOutboxService>(NotificationOutboxService);
  });

  describe("processReferralCompletionForBooking - Configuration-Based Early Returns", () => {
    it.each([
      {
        name: "REFERRAL_ENABLED is false",
        enabled: false,
        releaseCondition: "COMPLETED",
      },
      {
        name: "REFERRAL_RELEASE_CONDITION is PAID (not COMPLETED)",
        enabled: true,
        releaseCondition: "PAID",
      },
      {
        name: "REFERRAL_ENABLED is false AND REFERRAL_RELEASE_CONDITION is PAID",
        enabled: false,
        releaseCondition: "PAID",
      },
    ])("should skip processing when $name", async ({ enabled, releaseCondition }) => {
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([
        { key: "REFERRAL_ENABLED", value: enabled, updatedAt: new Date(), updatedBy: "system" },
        {
          key: "REFERRAL_RELEASE_CONDITION",
          value: releaseCondition,
          updatedAt: new Date(),
          updatedBy: "system",
        },
      ]);

      await service.processReferralCompletionForBooking("booking-123");

      expect(databaseService.referralProgramConfig.findMany).toHaveBeenCalled();
      expect(databaseService.booking.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("processReferralCompletionForBooking - Booking Eligibility Checks", () => {
    beforeEach(() => {
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([
        { key: "REFERRAL_ENABLED", value: true, updatedAt: new Date(), updatedBy: "system" },
        {
          key: "REFERRAL_RELEASE_CONDITION",
          value: "COMPLETED",
          updatedAt: new Date(),
          updatedBy: "system",
        },
      ]);
    });

    it("should skip processing when booking does not exist", async () => {
      vi.mocked(databaseService.booking.findFirst).mockResolvedValue(null);

      await service.processReferralCompletionForBooking("non-existent-booking");

      expect(databaseService.booking.findFirst).toHaveBeenCalledWith({
        where: { id: "non-existent-booking", deletedAt: null },
        select: {
          id: true,
          userId: true,
          referralReferrerUserId: true,
          referralStatus: true,
        },
      });
      expect(databaseService.$transaction).not.toHaveBeenCalled();
    });

    it("should skip processing when booking referralStatus is not APPLIED", async () => {
      const booking = createBooking({ id: "booking-1231" });
      vi.mocked(databaseService.booking.findFirst).mockResolvedValue(booking);

      await service.processReferralCompletionForBooking("booking-123");

      expect(databaseService.booking.findFirst).toHaveBeenCalled();
      expect(databaseService.$transaction).not.toHaveBeenCalled();
    });

    it("should skip processing when booking has no userId", async () => {
      const booking = createBooking({
        id: "booking-1231",
        referralStatus: BookingReferralStatus.APPLIED,
        referralReferrerUserId: "referrer-123",
        userId: undefined,
      });

      vi.mocked(databaseService.booking.findFirst).mockResolvedValue(booking);

      await service.processReferralCompletionForBooking("booking-123");

      expect(databaseService.booking.findFirst).toHaveBeenCalled();
      expect(databaseService.$transaction).not.toHaveBeenCalled();
    });

    it("should skip processing when booking has no referralReferrerUserId", async () => {
      const booking = createBooking({
        id: "booking-1231",
        referralStatus: BookingReferralStatus.APPLIED,
        referralReferrerUserId: undefined,
      });

      vi.mocked(databaseService.booking.findFirst).mockResolvedValue(booking);

      await service.processReferralCompletionForBooking("booking-123");

      expect(databaseService.booking.findFirst).toHaveBeenCalled();
      expect(databaseService.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("processReferralCompletionForBooking - Idempotency and Transaction Logic", () => {
    beforeEach(() => {
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([
        { key: "REFERRAL_ENABLED", value: true, updatedAt: new Date(), updatedBy: "system" },
        {
          key: "REFERRAL_RELEASE_CONDITION",
          value: "COMPLETED",
          updatedAt: new Date(),
          updatedBy: "system",
        },
        { key: "REFERRAL_EXPIRY_DAYS", value: 0, updatedAt: new Date(), updatedBy: "system" },
      ]);

      const booking = createBooking({
        id: "booking-1231",
        referralStatus: BookingReferralStatus.APPLIED,
        referralReferrerUserId: "referrer-123",
      });

      vi.mocked(databaseService.booking.findFirst).mockResolvedValue(booking);
    });

    it("should skip processing when reward is already released (idempotency)", async () => {
      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi.fn().mockResolvedValue({
              id: "reward-already-released",
              status: ReferralRewardStatus.RELEASED,
            }),
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      expect(databaseService.$transaction).toHaveBeenCalled();
    });
  });

  describe("processReferralCompletionForBooking - Expiry Window Checks", () => {
    beforeEach(() => {
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([
        { key: "REFERRAL_ENABLED", value: true, updatedAt: new Date(), updatedBy: "system" },
        {
          key: "REFERRAL_RELEASE_CONDITION",
          value: "COMPLETED",
          updatedAt: new Date(),
          updatedBy: "system",
        },
        { key: "REFERRAL_EXPIRY_DAYS", value: 30, updatedAt: new Date(), updatedBy: "system" },
      ]);

      const booking = createBooking({
        id: "booking-1231",
        referralStatus: BookingReferralStatus.APPLIED,
        referralReferrerUserId: "referrer-123",
      });

      vi.mocked(databaseService.booking.findFirst).mockResolvedValue(booking);
    });

    it("should skip processing when referral has expired", async () => {
      const fortyDaysAgo = new Date();
      fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 40);

      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi.fn().mockResolvedValue(null),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "user-123",
              referralSignupAt: fortyDaysAgo,
              referralDiscountUsed: false,
            }),
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      expect(databaseService.$transaction).toHaveBeenCalled();
    });

    it("should process when within expiry window - signup date is 20 days ago (within 30 day window)", async () => {
      const twentyDaysAgo = new Date();
      twentyDaysAgo.setDate(twentyDaysAgo.getDate() - 20);

      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(null) // First call: check if already released
              .mockResolvedValueOnce({
                // Second call: find pending reward
                id: "reward-123",
                bookingId: "booking-123",
                referrerUserId: "referrer-123",
                amount: 1000,
                status: ReferralRewardStatus.PENDING,
              }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "user-123",
              referralSignupAt: twentyDaysAgo,
              referralDiscountUsed: false,
            }),
            update: vi.fn().mockResolvedValue({}),
          },
          booking: {
            update: vi.fn().mockResolvedValue({}),
          },
          userReferralStats: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      expect(databaseService.$transaction).toHaveBeenCalled();
    });

    it("should process when REFERRAL_EXPIRY_DAYS is 0 (disabled)", async () => {
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([
        { key: "REFERRAL_ENABLED", value: true, updatedAt: new Date(), updatedBy: "system" },
        {
          key: "REFERRAL_RELEASE_CONDITION",
          value: "COMPLETED",
          updatedAt: new Date(),
          updatedBy: "system",
        },
        { key: "REFERRAL_EXPIRY_DAYS", value: 0, updatedAt: new Date(), updatedBy: "system" },
      ]);

      const veryOldDate = new Date("2020-01-01");

      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
              id: "reward-123",
              bookingId: "booking-123",
              referrerUserId: "referrer-123",
              amount: 1000,
              status: ReferralRewardStatus.PENDING,
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "user-123",
              referralSignupAt: veryOldDate,
              referralDiscountUsed: false,
            }),
            update: vi.fn().mockResolvedValue({}),
          },
          booking: {
            update: vi.fn().mockResolvedValue({}),
          },
          userReferralStats: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      expect(databaseService.$transaction).toHaveBeenCalled();
    });

    it("should process when referee has no referralSignupAt date", async () => {
      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
              id: "reward-123",
              bookingId: "booking-123",
              referrerUserId: "referrer-123",
              amount: 1000,
              status: ReferralRewardStatus.PENDING,
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "user-123",
              referralSignupAt: null,
              referralDiscountUsed: false,
            }),
            update: vi.fn().mockResolvedValue({}),
          },
          booking: {
            update: vi.fn().mockResolvedValue({}),
          },
          userReferralStats: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      expect(databaseService.$transaction).toHaveBeenCalled();
    });
  });

  describe("processReferralCompletionForBooking - Pending Reward Checks", () => {
    beforeEach(() => {
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([
        { key: "REFERRAL_ENABLED", value: true, updatedAt: new Date(), updatedBy: "system" },
        {
          key: "REFERRAL_RELEASE_CONDITION",
          value: "COMPLETED",
          updatedAt: new Date(),
          updatedBy: "system",
        },
        { key: "REFERRAL_EXPIRY_DAYS", value: 0, updatedAt: new Date(), updatedBy: "system" },
      ]);

      const booking = createBooking({
        referralReferrerUserId: "referrer-123",
        referralStatus: BookingReferralStatus.APPLIED,
      });

      vi.mocked(databaseService.booking.findFirst).mockResolvedValue(booking);
    });

    it("should skip processing when no pending reward is found", async () => {
      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(null) // Not already released
              .mockResolvedValueOnce(null), // No pending reward
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "user-123",
              referralSignupAt: new Date(),
              referralDiscountUsed: false,
            }),
            update: vi.fn().mockResolvedValue({}),
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      expect(databaseService.$transaction).toHaveBeenCalled();
    });

    it("should skip processing when only non-PENDING rewards exist", async () => {
      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(null) // Not already released
              .mockResolvedValueOnce(null), // No pending reward (could be CANCELLED)
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "user-123",
              referralSignupAt: new Date(),
              referralDiscountUsed: false,
            }),
            update: vi.fn().mockResolvedValue({}),
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      expect(databaseService.$transaction).toHaveBeenCalled();
    });
  });

  describe("processReferralCompletionForBooking - Discount Usage Marking", () => {
    beforeEach(() => {
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([
        { key: "REFERRAL_ENABLED", value: true, updatedAt: new Date(), updatedBy: "system" },
        {
          key: "REFERRAL_RELEASE_CONDITION",
          value: "COMPLETED",
          updatedAt: new Date(),
          updatedBy: "system",
        },
        { key: "REFERRAL_EXPIRY_DAYS", value: 0, updatedAt: new Date(), updatedBy: "system" },
      ]);

      const booking = createBooking({
        referralReferrerUserId: "referrer-123",
        referralStatus: BookingReferralStatus.APPLIED,
      });

      vi.mocked(databaseService.booking.findFirst).mockResolvedValue(booking);
    });

    it("should mark referee discount as used when not already marked", async () => {
      const mockUserUpdate = vi.fn().mockResolvedValue({});

      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
              id: "reward-123",
              bookingId: "booking-123",
              referrerUserId: "referrer-123",
              amount: 1000,
              status: ReferralRewardStatus.PENDING,
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "user-123",
              referralSignupAt: new Date(),
              referralDiscountUsed: false,
            }),
            update: mockUserUpdate,
          },
          booking: {
            update: vi.fn().mockResolvedValue({}),
          },
          userReferralStats: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      expect(mockUserUpdate).toHaveBeenCalledWith({
        where: { id: "user-123" },
        data: { referralDiscountUsed: true },
      });
    });

    it("should NOT update discount when already marked as used", async () => {
      const mockUserUpdate = vi.fn().mockResolvedValue({});

      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
              id: "reward-123",
              bookingId: "booking-123",
              referrerUserId: "referrer-123",
              amount: 1000,
              status: ReferralRewardStatus.PENDING,
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "user-123",
              referralSignupAt: new Date(),
              referralDiscountUsed: true, // Already used
            }),
            update: mockUserUpdate,
          },
          booking: {
            update: vi.fn().mockResolvedValue({}),
          },
          userReferralStats: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it("should handle missing referee data gracefully", async () => {
      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
              id: "reward-123",
              bookingId: "booking-123",
              referrerUserId: "referrer-123",
              amount: 1000,
              status: ReferralRewardStatus.PENDING,
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue(null),
          },
          booking: {
            update: vi.fn().mockResolvedValue({}),
          },
          userReferralStats: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      expect(databaseService.$transaction).toHaveBeenCalled();
    });
  });

  describe("processReferralCompletionForBooking - Successful Processing Path", () => {
    beforeEach(() => {
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([
        { key: "REFERRAL_ENABLED", value: true, updatedAt: new Date(), updatedBy: "system" },
        {
          key: "REFERRAL_RELEASE_CONDITION",
          value: "COMPLETED",
          updatedAt: new Date(),
          updatedBy: "system",
        },
        { key: "REFERRAL_EXPIRY_DAYS", value: 0, updatedAt: new Date(), updatedBy: "system" },
      ]);

      vi.mocked(databaseService.booking.findFirst).mockResolvedValue(
        createBooking({
          referralReferrerUserId: "referrer-123",
          referralStatus: BookingReferralStatus.APPLIED,
        }),
      );
    });

    it("should successfully release reward and create new referrer stats", async () => {
      const mockRewardUpdate = vi.fn().mockResolvedValue({ count: 1 });
      const mockBookingUpdate = vi.fn().mockResolvedValue({});
      const mockStatsUpsert = vi.fn().mockResolvedValue({});

      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(null) // Not already released
              .mockResolvedValueOnce({
                // Pending reward exists
                id: "reward-123",
                bookingId: "booking-123",
                referrerUserId: "referrer-123",
                amount: 1000,
                status: ReferralRewardStatus.PENDING,
              }),
            updateMany: mockRewardUpdate,
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "user-123",
              referralSignupAt: new Date(),
              referralDiscountUsed: false,
            }),
            update: vi.fn().mockResolvedValue({}),
          },
          booking: {
            update: mockBookingUpdate,
          },
          userReferralStats: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: mockStatsUpsert,
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      expect(mockRewardUpdate).toHaveBeenCalledWith({
        where: {
          id: "reward-123",
          status: ReferralRewardStatus.PENDING,
          releaseCondition: ReferralReleaseCondition.COMPLETED,
        },
        data: expect.objectContaining({
          status: ReferralRewardStatus.RELEASED,
          processedAt: expect.any(Date),
        }),
      });

      expect(mockBookingUpdate).toHaveBeenCalledWith({
        where: { id: "booking-123" },
        data: { referralStatus: BookingReferralStatus.REWARDED },
      });

      expect(mockStatsUpsert).toHaveBeenCalledWith({
        where: { userId: "referrer-123" },
        create: {
          userId: "referrer-123",
          totalReferrals: 1,
          totalRewardsGranted: 1000,
          totalRewardsPending: 0,
          lastReferralAt: expect.any(Date),
        },
        update: {
          totalRewardsGranted: { increment: 1000 },
          totalRewardsPending: expect.anything(),
          lastReferralAt: expect.any(Date),
        },
      });

      const firstCall = mockStatsUpsert.mock.calls[0]?.[0];
      expect(firstCall.update.totalRewardsPending.toString()).toBe("0");
      expect(notificationOutboxService.create).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "BOOKING_LIFECYCLE" }),
        {
          rewardId: "reward-123",
          bookingId: expect.any(String),
          referrerUserId: "referrer-123",
          amount: 1000,
          releasedAt: expect.any(Date),
        },
        expect.any(Object),
      );
    });

    it("should successfully release reward and update existing referrer stats", async () => {
      const mockStatsUpsert = vi.fn().mockResolvedValue({});

      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
              id: "reward-123",
              bookingId: "booking-123",
              referrerUserId: "referrer-123",
              amount: 500,
              status: ReferralRewardStatus.PENDING,
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "user-123",
              referralSignupAt: new Date(),
              referralDiscountUsed: true,
            }),
            update: vi.fn().mockResolvedValue({}),
          },
          booking: {
            update: vi.fn().mockResolvedValue({}),
          },
          userReferralStats: {
            findUnique: vi.fn().mockResolvedValue({ totalRewardsPending: 1000 }),
            upsert: mockStatsUpsert,
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      expect(mockStatsUpsert).toHaveBeenCalledWith({
        where: { userId: "referrer-123" },
        create: expect.anything(),
        update: {
          totalRewardsGranted: { increment: 500 },
          totalRewardsPending: expect.anything(),
          lastReferralAt: expect.any(Date),
        },
      });

      const firstCall = mockStatsUpsert.mock.calls[0]?.[0];
      expect(firstCall.update.totalRewardsPending.toString()).toBe("500");
    });

    it("should clamp totalRewardsPending to zero when pending amount exceeds current stats", async () => {
      const mockStatsUpsert = vi.fn().mockResolvedValue({});

      const mockTransaction = vi.fn(async (callback) => {
        const mockTx = {
          referralReward: {
            findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
              id: "reward-123",
              bookingId: "booking-123",
              referrerUserId: "referrer-123",
              amount: 500,
              status: ReferralRewardStatus.PENDING,
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "user-123",
              referralSignupAt: new Date(),
              referralDiscountUsed: true,
            }),
            update: vi.fn().mockResolvedValue({}),
          },
          booking: {
            update: vi.fn().mockResolvedValue({}),
          },
          userReferralStats: {
            findUnique: vi.fn().mockResolvedValue({ totalRewardsPending: 100 }),
            upsert: mockStatsUpsert,
          },
        };
        return callback(mockTx);
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await service.processReferralCompletionForBooking("booking-123");

      const firstCall = mockStatsUpsert.mock.calls[0]?.[0];
      expect(firstCall.update.totalRewardsPending.toString()).toBe("0");
    });
  });

  describe("processReferralCompletionForBooking - Transaction and Error Handling", () => {
    beforeEach(() => {
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([
        { key: "REFERRAL_ENABLED", value: true, updatedAt: new Date(), updatedBy: "system" },
        {
          key: "REFERRAL_RELEASE_CONDITION",
          value: "COMPLETED",
          updatedAt: new Date(),
          updatedBy: "system",
        },
        { key: "REFERRAL_EXPIRY_DAYS", value: 0, updatedAt: new Date(), updatedBy: "system" },
      ]);

      vi.mocked(databaseService.booking.findFirst).mockResolvedValue(
        createBooking({
          id: "booking-123",
          userId: "user-123",
          referralReferrerUserId: "referrer-123",
          referralStatus: BookingReferralStatus.APPLIED,
        }),
      );
    });

    it("should rollback and rethrow if any database operation fails", async () => {
      const mockTransaction = vi.fn(async () => {
        throw new Error("Database constraint violation");
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await expect(service.processReferralCompletionForBooking("booking-123")).rejects.toThrow(
        "Database constraint violation",
      );

      expect(databaseService.$transaction).toHaveBeenCalled();
    });

    it("should rethrow errors so BullMQ can retry", async () => {
      const mockTransaction = vi.fn(async () => {
        throw new Error("Unexpected database error");
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await expect(service.processReferralCompletionForBooking("booking-123")).rejects.toThrow(
        "Unexpected database error",
      );
    });

    it("should rethrow database connection errors", async () => {
      const mockTransaction = vi.fn(async () => {
        const error = new Error("Connection timeout");
        error.name = "DatabaseConnectionError";
        throw error;
      });

      vi.mocked(databaseService.$transaction).mockImplementation(mockTransaction);

      await expect(service.processReferralCompletionForBooking("booking-123")).rejects.toThrow(
        "Connection timeout",
      );

      expect(databaseService.$transaction).toHaveBeenCalled();
    });
  });
});
