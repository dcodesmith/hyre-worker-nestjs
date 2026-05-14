import { Injectable } from "@nestjs/common";
import {
  BookingReferralStatus,
  BookingStatus,
  Prisma,
  ReferralReleaseCondition,
  ReferralRewardStatus,
} from "@prisma/client";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import { ReferralDiscountNoLongerAvailableException } from "./booking.error";
import type { ReferralEligibility } from "./booking.interface";

@Injectable()
export class BookingEligibilityService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingEligibilityService.name);
  }

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

  async checkReferralEligibilityForPricing(
    sessionUser: AuthSession["user"] | null,
    bookingAmount: Decimal,
    bookingType: string,
  ): Promise<ReferralEligibility> {
    if (!sessionUser) {
      return this.getIneligibleReferralEligibility();
    }

    const user = await this.databaseService.user.findUnique({
      where: { id: sessionUser.id },
      select: {
        referredByUserId: true,
        referralDiscountUsed: true,
        referralSignupAt: true,
      },
    });

    if (!user?.referredByUserId || user.referralDiscountUsed) {
      return this.getIneligibleReferralEligibility();
    }

    const config = await this.getReferralPricingConfig();
    if (!config.enabled || config.discountAmount.lte(0)) {
      return this.getIneligibleReferralEligibility();
    }

    const existingReserved = await this.databaseService.booking.findFirst({
      where: {
        userId: sessionUser.id,
        referralStatus: { in: [BookingReferralStatus.APPLIED, BookingReferralStatus.REWARDED] },
        status: {
          in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.ACTIVE],
        },
      },
      select: { id: true },
    });

    if (existingReserved) {
      return this.getIneligibleReferralEligibility();
    }

    if (bookingAmount.lt(config.minBookingAmount)) {
      return this.getIneligibleReferralEligibility();
    }

    if (!config.eligibleTypes.includes(bookingType)) {
      return this.getIneligibleReferralEligibility();
    }

    if (config.expiryDays > 0 && user.referralSignupAt) {
      const expiryDate = new Date(user.referralSignupAt);
      expiryDate.setDate(expiryDate.getDate() + config.expiryDays);

      if (new Date() > expiryDate) {
        return this.getIneligibleReferralEligibility();
      }
    }

    return {
      eligible: true,
      referrerUserId: user.referredByUserId,
      discountAmount: Decimal.min(config.discountAmount, bookingAmount),
    };
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
      this.logger.warn({ userId }, "User not found during referral verification");
      return this.getIneligibleReferralEligibility();
    }

    if (freshUser.referralDiscountUsed) {
      this.logger.warn(
        {
          userId,
          preliminaryEligible: preliminaryEligibility.eligible,
        },
        "Referral discount already used (race condition detected)",
      );
      throw new ReferralDiscountNoLongerAvailableException();
    }

    if (!freshUser.referredByUserId) {
      this.logger.warn({ userId }, "User no longer has a referrer");
      return this.getIneligibleReferralEligibility();
    }

    await tx.user.update({
      where: { id: userId },
      data: { referralDiscountUsed: true },
    });

    this.logger.info({ userId }, "Referral discount claimed and marked as used");
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

    this.logger.info(
      {
        bookingId,
        referrerUserId: referralEligibility.referrerUserId,
        rewardAmount: rewardAmount.toString(),
      },
      "Created pending referral reward",
    );
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

  private async getReferralPricingConfig(): Promise<{
    enabled: boolean;
    discountAmount: Decimal;
    minBookingAmount: Decimal;
    eligibleTypes: string[];
    expiryDays: number;
  }> {
    const configMap = await this.getReferralConfigMap(this.databaseService.referralProgramConfig, [
      "REFERRAL_ENABLED",
      "REFERRAL_DISCOUNT_AMOUNT",
      "REFERRAL_MIN_BOOKING_AMOUNT",
      "REFERRAL_ELIGIBLE_TYPES",
      "REFERRAL_EXPIRY_DAYS",
    ]);

    return {
      enabled: this.parseEnabledConfig(configMap.REFERRAL_ENABLED ?? true),
      discountAmount: this.parseDecimalConfig(
        configMap.REFERRAL_DISCOUNT_AMOUNT ?? 10000,
        "REFERRAL_DISCOUNT_AMOUNT",
      ),
      minBookingAmount: this.parseDecimalConfig(
        configMap.REFERRAL_MIN_BOOKING_AMOUNT ?? 20000,
        "REFERRAL_MIN_BOOKING_AMOUNT",
      ),
      eligibleTypes: this.parseStringArrayConfig(configMap.REFERRAL_ELIGIBLE_TYPES, [
        "DAY",
        "NIGHT",
        "FULL_DAY",
      ]),
      expiryDays: this.parseNumberConfig(configMap.REFERRAL_EXPIRY_DAYS ?? 30, 30),
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

    this.logger.warn(
      {
        type: typeof rawValue,
        value: rawValue,
      },
      `Invalid ${key} config value type`,
    );
    return new Decimal(0);
  }

  private parseNumberConfig(rawValue: unknown, fallback: number): number {
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      return rawValue;
    }
    if (typeof rawValue === "string") {
      const parsed = Number(rawValue);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
  }

  private parseStringArrayConfig(rawValue: unknown, fallback: string[]): string[] {
    if (!Array.isArray(rawValue)) {
      return fallback;
    }
    const strings = rawValue.filter((item): item is string => typeof item === "string");
    return strings.length > 0 ? strings : fallback;
  }

  private parseReleaseConditionConfig(rawValue: unknown): ReferralReleaseCondition {
    return rawValue === "PAID" ? ReferralReleaseCondition.PAID : ReferralReleaseCondition.COMPLETED;
  }
}
