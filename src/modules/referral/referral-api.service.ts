import { Injectable } from "@nestjs/common";
import {
  BookingReferralStatus,
  BookingStatus,
  type BookingType,
  PaymentStatus,
  type Prisma,
  ReferralIncentiveType,
  ReferralProgramStatus,
  ReferralRewardStatus,
} from "@prisma/client";
import Decimal from "decimal.js";
import { maskEmail } from "../../shared/helper";
import { DatabaseService } from "../database/database.service";
import {
  ReferralInvalidCodeException,
  ReferralProgramInactiveException,
  ReferralSelfReferralException,
} from "./referral.error";
import type { ReferralUserSummaryResponse } from "./referral.interface";
import { ReferralProgramService } from "./referral-program.service";

@Injectable()
export class ReferralApiService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly referralProgramService: ReferralProgramService,
  ) {}

  async validateReferralCode(code: string, userEmail: string) {
    if (!(await this.referralProgramService.getActiveProgram())) {
      throw new ReferralProgramInactiveException();
    }

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

  async checkReferralEligibility(userId: string, bookingAmount: number, bookingType: BookingType) {
    const program = await this.referralProgramService.getActiveProgram();

    if (!program) {
      return { eligible: false, reason: "Referral programme is not active", discountAmount: 0 };
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

    if (new Decimal(bookingAmount).lt(program.minimumBookingAmount)) {
      return {
        eligible: false,
        reason: `Booking amount must be at least ₦${program.minimumBookingAmount
          .toNumber()
          .toLocaleString()}`,
        discountAmount: 0,
      };
    }

    if (!program.eligibleBookingTypes.includes(bookingType)) {
      return {
        eligible: false,
        reason: "Booking type is not eligible for referral discount",
        discountAmount: 0,
      };
    }

    if (program.referralValidityDays > 0 && user.referralSignupAt) {
      const expiryDate = new Date(user.referralSignupAt);
      expiryDate.setDate(expiryDate.getDate() + program.referralValidityDays);

      if (new Date() > expiryDate) {
        return { eligible: false, reason: "Referral discount has expired", discountAmount: 0 };
      }
    }

    return {
      eligible: true,
      discountAmount: this.referralProgramService
        .calculateRefereeDiscount(program, new Decimal(bookingAmount))
        .toNumber(),
      reason: undefined,
    };
  }

  async getUserReferralSummary(
    userId: string,
    requestOrigin: string | null,
  ): Promise<ReferralUserSummaryResponse | null> {
    const [referralInfo, rewardTotals, program] = await Promise.all([
      this.databaseService.user.findUnique({
        where: { id: userId },
        select: {
          referralCode: true,
          referredByUserId: true,
          referralDiscountUsed: true,
          referralSignupAt: true,
          _count: { select: { referrals: true } },
          referrals: {
            select: {
              id: true,
              name: true,
              email: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
            take: 50,
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
      this.referralProgramService.getProgram(),
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
      programEnabled: program?.status === ReferralProgramStatus.ACTIVE,
      discountAmount: program
        ? program.refereeDiscountType === ReferralIncentiveType.FIXED
          ? program.refereeDiscountValue.toNumber()
          : (program.refereeDiscountMaxAmount?.toNumber() ?? 0)
        : 0,
      discount: program
        ? program.refereeDiscountType === ReferralIncentiveType.FIXED
          ? {
              type: ReferralIncentiveType.FIXED,
              amount: program.refereeDiscountValue.toNumber(),
            }
          : {
              type: ReferralIncentiveType.PERCENTAGE,
              percentage: program.refereeDiscountValue.toNumber(),
              maxAmount: program.refereeDiscountMaxAmount?.toNumber() ?? 0,
            }
        : null,
      hasUsedDiscount: referralInfo.referralDiscountUsed,
      referredBy: referralInfo.referredByUserId,
      signupDate: referralInfo.referralSignupAt,
      stats: {
        totalReferrals: referralInfo._count.referrals,
        totalRewardsGranted: rewardTotals.totalReleased,
        totalRewardsPending: rewardTotals.totalPending,
        lastReferralAt: referralInfo.referrals[0]?.createdAt ?? null,
        totalEarned: bookingCredits.totalEarned,
        totalUsed: bookingCredits.totalUsed,
        availableCredits: bookingCredits.availableCredits,
        maxCreditsPerBooking: program?.maxCreditsPerBookingAmount.toNumber() ?? 0,
      },
      referrals: referralInfo.referrals.map((referral) => ({
        ...referral,
        email: maskEmail(referral.email),
      })),
      rewards: referralInfo.referralRewardsEarned.map((reward) => ({
        id: reward.id,
        amount: this.decimalToNumber(reward.amount),
        status: reward.status,
        createdAt: reward.createdAt,
        processedAt: reward.processedAt,
        refereeName:
          reward.referee?.name ||
          (reward.referee?.email ? maskEmail(reward.referee.email) : "Unknown"),
      })),
    };
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
          paymentStatus: {
            in: [
              PaymentStatus.PAID,
              PaymentStatus.PARTIALLY_REFUNDED,
              PaymentStatus.REFUND_PROCESSING,
              PaymentStatus.REFUND_FAILED,
            ],
          },
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
