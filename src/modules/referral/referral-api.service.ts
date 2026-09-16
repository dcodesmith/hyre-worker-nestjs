import { Injectable } from "@nestjs/common";
import {
  BookingReferralStatus,
  BookingStatus,
  PaymentStatus,
  type Prisma,
  ReferralRewardStatus,
} from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import { ReferralInvalidCodeException, ReferralSelfReferralException } from "./referral.error";
import type { ReferralUserSummaryResponse } from "./referral.interface";
import { loadReferralProgramConfig, type ReferralProgramConfig } from "./referral-program-config";

@Injectable()
export class ReferralApiService {
  private configCache:
    | {
        value: ReferralProgramConfig;
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

    if (!config.enabled) {
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
        referralStatus: {
          in: [
            BookingReferralStatus.RESERVED,
            BookingReferralStatus.APPLIED,
            BookingReferralStatus.REWARDED,
          ],
        },
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

    if (bookingAmount < config.minBookingAmount) {
      return {
        eligible: false,
        reason: `Booking amount must be at least ₦${config.minBookingAmount.toLocaleString()}`,
        discountAmount: 0,
      };
    }

    if (!config.eligibleTypes.includes(bookingType)) {
      return {
        eligible: false,
        reason: "Booking type is not eligible for referral discount",
        discountAmount: 0,
      };
    }

    if (config.expiryDays > 0 && user.referralSignupAt) {
      const expiryDate = new Date(user.referralSignupAt);
      expiryDate.setDate(expiryDate.getDate() + config.expiryDays);

      if (new Date() > expiryDate) {
        return { eligible: false, reason: "Referral discount has expired", discountAmount: 0 };
      }
    }

    return {
      eligible: true,
      discountAmount: Math.min(config.discountAmount, bookingAmount),
      reason: undefined,
    };
  }

  async getUserReferralSummary(
    userId: string,
    requestOrigin: string | null,
  ): Promise<ReferralUserSummaryResponse | null> {
    const [referralInfo, rewardTotals, config] = await Promise.all([
      this.databaseService.user.findUnique({
        where: { id: userId },
        select: {
          referralCode: true,
          referredByUserId: true,
          referralDiscountUsed: true,
          referralSignupAt: true,
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
      this.getReferralRewardTotals(userId),
      this.getReferralConfig(),
    ]);

    if (!referralInfo) {
      return null;
    }

    const bookingCredits = await this.getUserBookingCredits(userId, rewardTotals.totalReleased);
    const shareLink =
      referralInfo.referralCode && requestOrigin
        ? `${requestOrigin}/auth?ref=${referralInfo.referralCode}`
        : null;

    return {
      referralCode: referralInfo.referralCode,
      shareLink,
      programEnabled: config.enabled,
      discountAmount: config.discountAmount,
      hasUsedDiscount: referralInfo.referralDiscountUsed,
      referredBy: referralInfo.referredByUserId,
      signupDate: referralInfo.referralSignupAt,
      stats: {
        totalReferrals: referralInfo.referrals.length,
        totalRewardsGranted: rewardTotals.totalReleased,
        totalRewardsPending: rewardTotals.totalPending,
        lastReferralAt: this.getLastReferralAt(referralInfo.referrals),
        totalEarned: bookingCredits.totalEarned,
        totalUsed: bookingCredits.totalUsed,
        availableCredits: bookingCredits.availableCredits,
        maxCreditsPerBooking: config.maxCreditsPerBooking,
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

  private async getReferralConfig(): Promise<ReferralProgramConfig> {
    const now = Date.now();
    if (this.configCache && this.configCache.expiresAt > now) {
      return this.configCache.value;
    }

    const config = await loadReferralProgramConfig(this.databaseService.referralProgramConfig);

    this.configCache = {
      value: config,
      expiresAt: now + this.configTtlMs,
    };

    return config;
  }

  private async getReferralRewardTotals(userId: string) {
    const [releasedRewards, pendingRewards] = await Promise.all([
      this.databaseService.referralReward.aggregate({
        where: {
          referrerUserId: userId,
          status: ReferralRewardStatus.RELEASED,
        },
        _sum: { amount: true },
      }),
      this.databaseService.referralReward.aggregate({
        where: {
          referrerUserId: userId,
          status: ReferralRewardStatus.PENDING,
        },
        _sum: { amount: true },
      }),
    ]);

    return {
      totalReleased: this.decimalToNumber(releasedRewards._sum.amount),
      totalPending: this.decimalToNumber(pendingRewards._sum.amount),
    };
  }

  private async getUserBookingCredits(userId: string, totalEarned: number) {
    const [usedCredits, reservedCredits] = await Promise.all([
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

    const totalUsed = this.decimalToNumber(usedCredits._sum.referralCreditsUsed);
    const totalReserved = this.decimalToNumber(reservedCredits._sum.referralCreditsReserved);

    return {
      totalEarned,
      totalUsed,
      totalReserved,
      availableCredits: Math.max(0, totalEarned - totalUsed - totalReserved),
    };
  }

  private getLastReferralAt(referrals: Array<{ createdAt: Date }>): Date | null {
    let latest: Date | null = null;
    for (const referral of referrals) {
      if (!latest || referral.createdAt > latest) {
        latest = referral.createdAt;
      }
    }
    return latest;
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
}
