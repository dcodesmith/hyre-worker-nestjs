import { Injectable } from "@nestjs/common";
import { BookingReferralStatus, BookingStatus, PaymentStatus, type Prisma } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import { ReferralInvalidCodeException, ReferralSelfReferralException } from "./referral.error";
import type { ReferralConfig, ReferralUserSummaryResponse } from "./referral.interface";

@Injectable()
export class ReferralApiService {
  private configCache:
    | {
        value: ReferralConfig;
        expiresAt: number;
      }
    | undefined;

  private readonly configTtlMs = 60 * 1000;

  constructor(private readonly databaseService: DatabaseService) {}

  async validateReferralCode(code: string, userEmail: string) {
    const referrer = await this.databaseService.user.findUnique({
      where: { referralCode: code },
      select: {
        id: true,
        name: true,
        email: true,
        referralCode: true,
      },
    });

    if (!referrer) {
      throw new ReferralInvalidCodeException();
    }

    if (userEmail?.toLowerCase() === referrer.email.toLowerCase()) {
      throw new ReferralSelfReferralException();
    }

    return referrer;
  }

  async checkReferralEligibility(userId: string, bookingAmount: number, bookingType: string) {
    const config = await this.getReferralConfig();

    if (!config.REFERRAL_ENABLED) {
      return { eligible: false, reason: "Referral program is disabled", discountAmount: 0 };
    }

    const user = await this.databaseService.user.findUnique({
      where: { id: userId },
      select: {
        referredByUserId: true,
        referralDiscountUsed: true,
        referralSignupAt: true,
      },
    });

    if (!user?.referredByUserId) {
      return { eligible: false, reason: "User was not referred", discountAmount: 0 };
    }

    if (user.referralDiscountUsed) {
      return { eligible: false, reason: "Referral discount already used", discountAmount: 0 };
    }

    const existingReserved = await this.databaseService.booking.findFirst({
      where: {
        userId,
        referralStatus: { in: [BookingReferralStatus.APPLIED, BookingReferralStatus.REWARDED] },
        status: {
          in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.ACTIVE],
        },
      },
      select: { id: true },
    });

    if (existingReserved) {
      return {
        eligible: false,
        reason: "Referral discount already reserved or used",
        discountAmount: 0,
      };
    }

    if (bookingAmount < config.REFERRAL_MIN_BOOKING_AMOUNT) {
      return {
        eligible: false,
        reason: `Booking amount must be at least ₦${config.REFERRAL_MIN_BOOKING_AMOUNT.toLocaleString()}`,
        discountAmount: 0,
      };
    }

    if (!config.REFERRAL_ELIGIBLE_TYPES.includes(bookingType)) {
      return {
        eligible: false,
        reason: "Booking type is not eligible for referral discount",
        discountAmount: 0,
      };
    }

    if (config.REFERRAL_EXPIRY_DAYS > 0 && user.referralSignupAt) {
      const expiryDate = new Date(user.referralSignupAt);
      expiryDate.setDate(expiryDate.getDate() + config.REFERRAL_EXPIRY_DAYS);

      if (new Date() > expiryDate) {
        return { eligible: false, reason: "Referral discount has expired", discountAmount: 0 };
      }
    }

    return {
      eligible: true,
      discountAmount: Math.min(config.REFERRAL_DISCOUNT_AMOUNT, bookingAmount),
      reason: undefined,
    };
  }

  async getUserReferralSummary(
    userId: string,
    requestOrigin: string,
  ): Promise<ReferralUserSummaryResponse | null> {
    const [referralInfo, bookingCredits, config] = await Promise.all([
      this.databaseService.user.findUnique({
        where: { id: userId },
        select: {
          referralCode: true,
          referredByUserId: true,
          referralDiscountUsed: true,
          referralSignupAt: true,
          referralStats: {
            select: {
              totalReferrals: true,
              totalRewardsGranted: true,
              totalRewardsPending: true,
              lastReferralAt: true,
            },
          },
          referrals: {
            select: {
              id: true,
              name: true,
              email: true,
              createdAt: true,
            },
          },
          referralRewardsEarned: {
            select: {
              id: true,
              amount: true,
              status: true,
              createdAt: true,
              processedAt: true,
              referee: {
                select: {
                  name: true,
                  email: true,
                },
              },
            },
            orderBy: { createdAt: "desc" },
            take: 50,
          },
        },
      }),
      this.getUserBookingCredits(userId),
      this.getReferralConfig(),
    ]);

    if (!referralInfo) {
      return null;
    }

    const shareLink = referralInfo.referralCode
      ? `${requestOrigin}/auth?ref=${referralInfo.referralCode}`
      : null;

    const totalRewardsGranted = this.decimalToNumber(
      referralInfo.referralStats?.totalRewardsGranted,
    );
    const totalRewardsPending = this.decimalToNumber(
      referralInfo.referralStats?.totalRewardsPending,
    );

    return {
      referralCode: referralInfo.referralCode,
      shareLink,
      hasUsedDiscount: referralInfo.referralDiscountUsed,
      referredBy: referralInfo.referredByUserId,
      signupDate: referralInfo.referralSignupAt,
      stats: {
        totalReferrals: referralInfo.referralStats?.totalReferrals ?? 0,
        totalRewardsGranted,
        totalRewardsPending,
        lastReferralAt: referralInfo.referralStats?.lastReferralAt ?? null,
        totalEarned: bookingCredits.totalEarned,
        totalUsed: bookingCredits.totalUsed,
        availableCredits: bookingCredits.availableCredits,
        maxCreditsPerBooking: config.REFERRAL_MAX_CREDITS_PER_BOOKING,
      },
      referrals: referralInfo.referrals,
      rewards: referralInfo.referralRewardsEarned.map((reward) => ({
        id: reward.id,
        amount: this.decimalToNumber(reward.amount),
        status: reward.status,
        createdAt: reward.createdAt,
        processedAt: reward.processedAt,
        refereeName: reward.referee?.name || reward.referee?.email || "Unknown",
      })),
    };
  }

  private async getReferralConfig(): Promise<ReferralConfig> {
    const now = Date.now();
    if (this.configCache && this.configCache.expiresAt > now) {
      return this.configCache.value;
    }

    const rows = await this.databaseService.referralProgramConfig.findMany();
    const map = rows.reduce<Record<string, unknown>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    const config: ReferralConfig = {
      REFERRAL_ENABLED: Boolean(map.REFERRAL_ENABLED ?? true),
      REFERRAL_DISCOUNT_AMOUNT: Number(map.REFERRAL_DISCOUNT_AMOUNT ?? 10000),
      REFERRAL_MIN_BOOKING_AMOUNT: Number(map.REFERRAL_MIN_BOOKING_AMOUNT ?? 20000),
      REFERRAL_ELIGIBLE_TYPES: this.asStringArray(map.REFERRAL_ELIGIBLE_TYPES, [
        "DAY",
        "NIGHT",
        "FULL_DAY",
      ]),
      REFERRAL_RELEASE_CONDITION: map.REFERRAL_RELEASE_CONDITION === "PAID" ? "PAID" : "COMPLETED",
      REFERRAL_EXPIRY_DAYS: Number(map.REFERRAL_EXPIRY_DAYS ?? 30),
      REFERRAL_MAX_CREDITS_PER_BOOKING: Number(map.REFERRAL_MAX_CREDITS_PER_BOOKING ?? 30000),
    };

    this.configCache = {
      value: config,
      expiresAt: now + this.configTtlMs,
    };

    return config;
  }

  private async getUserBookingCredits(userId: string) {
    const [stats, usedCredits, reservedCredits] = await Promise.all([
      this.databaseService.userReferralStats.findUnique({
        where: { userId },
        select: { totalRewardsGranted: true },
      }),
      this.databaseService.booking.aggregate({
        where: {
          paymentStatus: PaymentStatus.PAID,
          userId,
          referralCreditsUsed: { gt: 0 },
        },
        _sum: { referralCreditsUsed: true },
      }),
      this.databaseService.booking.aggregate({
        where: {
          paymentStatus: PaymentStatus.UNPAID,
          status: { notIn: [BookingStatus.CANCELLED] },
          userId,
          referralCreditsReserved: { gt: 0 },
        },
        _sum: { referralCreditsReserved: true },
      }),
    ]);

    const totalEarned = this.decimalToNumber(stats?.totalRewardsGranted);
    const totalUsed = this.decimalToNumber(usedCredits._sum.referralCreditsUsed);
    const totalReserved = this.decimalToNumber(reservedCredits._sum.referralCreditsReserved);

    return {
      totalEarned,
      totalUsed,
      totalReserved,
      availableCredits: Math.max(0, totalEarned - totalUsed - totalReserved),
    };
  }

  private decimalToNumber(value: Prisma.Decimal | number | null | undefined): number {
    if (value === null || value === undefined) {
      return 0;
    }
    if (typeof value === "number") {
      return value;
    }
    return value.toNumber();
  }

  private asStringArray(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) {
      return fallback;
    }
    const strings = value.filter((item): item is string => typeof item === "string");
    return strings.length > 0 ? strings : fallback;
  }
}
