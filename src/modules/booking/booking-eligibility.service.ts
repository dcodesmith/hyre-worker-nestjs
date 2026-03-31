import { Injectable, Logger } from "@nestjs/common";
import { Prisma, ReferralReleaseCondition, ReferralRewardStatus } from "@prisma/client";
import Decimal from "decimal.js";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import { ReferralDiscountNoLongerAvailableException } from "./booking.error";
import type { ReferralEligibility } from "./booking.interface";

@Injectable()
export class BookingEligibilityService {
  private readonly logger = new Logger(BookingEligibilityService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  private getIneligibleReferralEligibility(): ReferralEligibility {
    return { eligible: false, referrerUserId: null, discountAmount: new Decimal(0) };
  }

  async checkPreliminaryReferralEligibility(
    sessionUser: AuthSession["user"] | null,
  ): Promise<ReferralEligibility> {
    if (!sessionUser) {
      return this.getIneligibleReferralEligibility();
    }

    const user = await this.databaseService.user.findUnique({
      where: { id: sessionUser.id },
      select: {
        referredByUserId: true,
        referralDiscountUsed: true,
      },
    });

    if (!user?.referredByUserId || user.referralDiscountUsed) {
      return this.getIneligibleReferralEligibility();
    }

    return this.getReferralConfig(user.referredByUserId);
  }

  async verifyAndClaimReferralDiscountInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    preliminaryEligibility: ReferralEligibility,
  ): Promise<ReferralEligibility> {
    if (!preliminaryEligibility.eligible) {
      return preliminaryEligibility;
    }

    const users = await tx.$queryRaw<
      Array<{ id: string; referredByUserId: string | null; referralDiscountUsed: boolean }>
    >`SELECT id, "referredByUserId", "referralDiscountUsed" FROM "User" WHERE id = ${userId} FOR UPDATE`;

    const freshUser = users[0];

    if (!freshUser) {
      this.logger.warn("User not found during referral verification", { userId });
      return this.getIneligibleReferralEligibility();
    }

    if (freshUser.referralDiscountUsed) {
      this.logger.warn("Referral discount already used (race condition detected)", {
        userId,
        preliminaryEligible: preliminaryEligibility.eligible,
      });
      throw new ReferralDiscountNoLongerAvailableException();
    }

    if (!freshUser.referredByUserId) {
      this.logger.warn("User no longer has a referrer", { userId });
      return this.getIneligibleReferralEligibility();
    }

    await tx.user.update({
      where: { id: userId },
      data: { referralDiscountUsed: true },
    });

    this.logger.log("Referral discount claimed and marked as used", { userId });
    return preliminaryEligibility;
  }

  async createReferralRewardIfEligible(
    tx: Prisma.TransactionClient,
    bookingId: string,
    referralEligibility: ReferralEligibility,
    userId: string | null,
  ): Promise<void> {
    if (!referralEligibility.eligible || !referralEligibility.referrerUserId || !userId) {
      return;
    }

    const rewardConfigMap = await this.getReferralConfigMap(tx.referralProgramConfig, [
      "REFERRAL_REWARD_AMOUNT",
      "REFERRAL_RELEASE_CONDITION",
    ]);

    const rewardAmount = this.parseDecimalConfig(
      rewardConfigMap.REFERRAL_REWARD_AMOUNT,
      "REFERRAL_REWARD_AMOUNT",
    );
    if (!rewardAmount.gt(0)) {
      return;
    }

    const releaseCondition = this.parseReleaseConditionConfig(
      rewardConfigMap.REFERRAL_RELEASE_CONDITION,
    );

    await tx.referralReward.create({
      data: {
        referrer: { connect: { id: referralEligibility.referrerUserId } },
        referee: { connect: { id: userId } },
        booking: { connect: { id: bookingId } },
        amount: rewardAmount,
        status: ReferralRewardStatus.PENDING,
        releaseCondition,
      },
    });

    await tx.userReferralStats.upsert({
      where: { userId: referralEligibility.referrerUserId },
      create: {
        userId: referralEligibility.referrerUserId,
        totalReferrals: 1,
        totalRewardsGranted: 0,
        totalRewardsPending: rewardAmount,
      },
      update: {
        totalReferrals: { increment: 1 },
        totalRewardsPending: { increment: rewardAmount },
      },
    });

    this.logger.log("Created pending referral reward", {
      bookingId,
      referrerUserId: referralEligibility.referrerUserId,
      rewardAmount: rewardAmount.toString(),
    });
  }

  private async getReferralConfig(referrerUserId: string): Promise<ReferralEligibility> {
    const configMap = await this.getReferralConfigMap(this.databaseService.referralProgramConfig, [
      "REFERRAL_ENABLED",
      "REFERRAL_DISCOUNT_AMOUNT",
    ]);

    const isEnabled = this.parseEnabledConfig(configMap.REFERRAL_ENABLED);
    const discountAmount = this.parseDecimalConfig(
      configMap.REFERRAL_DISCOUNT_AMOUNT,
      "REFERRAL_DISCOUNT_AMOUNT",
    );

    if (!isEnabled || discountAmount.lte(0)) {
      return this.getIneligibleReferralEligibility();
    }

    return {
      eligible: true,
      referrerUserId,
      discountAmount,
    };
  }

  private async getReferralConfigMap(
    referralProgramConfigModel: Pick<Prisma.TransactionClient["referralProgramConfig"], "findMany">,
    keys: string[],
  ): Promise<Record<string, unknown>> {
    const configs = await referralProgramConfigModel.findMany({
      where: { key: { in: keys } },
    });

    return configs.reduce<Record<string, unknown>>((acc, c) => {
      acc[c.key] = c.value;
      return acc;
    }, {});
  }

  private parseEnabledConfig(rawEnabled: unknown): boolean {
    if (typeof rawEnabled === "boolean") {
      return rawEnabled;
    }
    if (typeof rawEnabled === "string") {
      return rawEnabled.toLowerCase() === "true";
    }
    return false;
  }

  private parseDecimalConfig(rawValue: unknown, key: string): Decimal {
    if (rawValue === undefined || rawValue === null) {
      return new Decimal(0);
    }
    if (typeof rawValue === "number") {
      return new Decimal(rawValue);
    }
    if (typeof rawValue === "string") {
      const parsed = Number(rawValue);
      return Number.isFinite(parsed) ? new Decimal(parsed) : new Decimal(0);
    }

    this.logger.warn(`Invalid ${key} config value type`, {
      type: typeof rawValue,
      value: rawValue,
    });
    return new Decimal(0);
  }

  private parseReleaseConditionConfig(rawValue: unknown): ReferralReleaseCondition {
    return rawValue === "PAID" ? ReferralReleaseCondition.PAID : ReferralReleaseCondition.COMPLETED;
  }
}
