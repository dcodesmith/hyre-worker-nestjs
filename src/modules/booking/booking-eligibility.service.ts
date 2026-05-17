import { Injectable } from "@nestjs/common";
import {
  BookingReferralStatus,
  BookingStatus,
  PaymentStatus,
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

/**
 * Stored on `ReferralReward.reason` when a PENDING reward is tombstoned by
 * `releaseReferralReservation`. Distinct from `referral-processing.service.ts`
 * reversal reasons so audit logs can tell apart "user abandoned checkout" from
 * "release condition failed downstream".
 */
const RELEASED_RESERVATION_REASON = "RESERVATION_RELEASED";

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
      where: this.buildExistingDiscountClaimFilter(sessionUser.id),
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

  async verifyAndReserveReferralDiscountInTransaction(
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

    // A new booking attempt is the user's signal that any prior unpaid reservation is
    // abandoned. Release those reservations first so the eligibility check below sees
    // a fresh state. Any reservation still mid-payment (paymentStatus != UNPAID) or
    // already settled (APPLIED/REWARDED) is preserved and will block this attempt.
    await this.releaseStaleReferralReservationsForUser(tx, userId);

    const existingReserved = await tx.booking.findFirst({
      where: this.buildExistingDiscountClaimFilter(userId),
      select: { id: true },
    });

    if (existingReserved) {
      this.logger.warn(
        {
          userId,
          bookingId: existingReserved.id,
        },
        "Referral discount already reserved by an active booking",
      );
      throw new ReferralDiscountNoLongerAvailableException();
    }

    this.logger.info({ userId }, "Referral discount verified for booking reservation");
    return preliminaryEligibility;
  }

  /**
   * Release a referral discount reservation tied to a booking.
   *
   * Idempotent: only releases when the booking is still in
   * `RESERVED + PENDING + UNPAID` state. APPLIED/REWARDED bookings and any
   * booking with a non-UNPAID payment status are intentionally left alone — the
   * discount has either been settled or is mid-payment and must not be reverted.
   *
   * Effects when releasing:
   * - Clears `referralReferrerUserId`, zeroes `referralDiscountAmount`
   * - Sets `referralStatus = REVERSED`
   * - Soft-deletes any PENDING `ReferralReward` rows tied to the booking
   *   (status → REVERSED, sets `processedAt` and `reason`) so the audit trail
   *   of the reservation attempt is preserved
   * - Decrements the referrer's `UserReferralStats` counters
   *   (`totalReferrals`, `totalRewardsPending`) that `createReferralRewardIfEligible`
   *   incremented when the reservation was first made, with a floor at zero to
   *   defend against any historical drift
   *
   * Call this from a transaction so the reservation release is atomic with any
   * dependent work (e.g. reserving a new discount on a fresh booking).
   */
  async releaseReferralReservation(
    tx: Prisma.TransactionClient,
    bookingId: string,
  ): Promise<{ released: boolean }> {
    // Conditional update is atomic at the DB row level: the state predicates live
    // in the WHERE clause, so a concurrent transition (e.g. a late charge.completed
    // (successful) re-delivery flipping the booking to APPLIED+PAID) cannot be
    // clobbered by a stale read-then-write race. count === 0 means another writer
    // already moved the booking out of the releasable state.
    const { count } = await tx.booking.updateMany({
      where: {
        id: bookingId,
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

    if (count === 0) {
      return { released: false };
    }

    // Capture referrer + amount before flipping the rows: `updateMany` returns a
    // count only, but we need this data to decrement the matching stats counters.
    const pendingRewards = await tx.referralReward.findMany({
      where: { bookingId, status: ReferralRewardStatus.PENDING },
      select: { id: true, referrerUserId: true, amount: true },
    });

    if (pendingRewards.length > 0) {
      // Soft-delete: tombstone the row with status REVERSED + processedAt + reason
      // so we keep an auditable record of every reservation attempt. The re-check
      // on `status: PENDING` is a guard against a concurrent writer transitioning
      // the same row in between our findMany and updateMany.
      await tx.referralReward.updateMany({
        where: {
          id: { in: pendingRewards.map((r) => r.id) },
          status: ReferralRewardStatus.PENDING,
        },
        data: {
          status: ReferralRewardStatus.REVERSED,
          processedAt: new Date(),
          reason: RELEASED_RESERVATION_REASON,
        },
      });

      await this.decrementReferralStatsForReversedRewards(tx, pendingRewards);
    }

    this.logger.info(
      { bookingId, reversedRewards: pendingRewards.length },
      "Released referral reservation",
    );

    return { released: true };
  }

  /**
   * Decrement `UserReferralStats` for each referrer affected by reward reversal.
   *
   * Read-modify-write inside the caller's transaction (safe because the tx sees
   * a consistent snapshot) with floor-at-zero — mirrors the pattern used in
   * `referral-processing.service.ts` when releasing a pending reward, and
   * defends against pre-existing drift where the counters might already be
   * lower than the decrement would suggest.
   *
   * Aggregates per referrer so a future where one booking has multiple PENDING
   * rewards for the same referrer collapses into a single update (today the
   * create path only ever produces one PENDING reward per booking).
   */
  private async decrementReferralStatsForReversedRewards(
    tx: Prisma.TransactionClient,
    rewards: Array<{ referrerUserId: string; amount: Decimal | Prisma.Decimal }>,
  ): Promise<void> {
    const perReferrer = new Map<string, { count: number; amount: Decimal }>();
    for (const reward of rewards) {
      const current = perReferrer.get(reward.referrerUserId) ?? {
        count: 0,
        amount: new Decimal(0),
      };
      perReferrer.set(reward.referrerUserId, {
        count: current.count + 1,
        amount: current.amount.plus(new Decimal(reward.amount.toString())),
      });
    }

    for (const [referrerUserId, { count, amount }] of perReferrer) {
      const stats = await tx.userReferralStats.findUnique({
        where: { userId: referrerUserId },
        select: { totalReferrals: true, totalRewardsPending: true },
      });

      if (!stats) {
        // No row to decrement against. This should not happen in practice
        // because `createReferralRewardIfEligible` upserts the row when it
        // creates the PENDING reward, but if we hit it we'd rather log than
        // create a meaningless zero row.
        this.logger.warn(
          {
            referrerUserId,
            decrementCount: count,
            decrementAmount: amount.toString(),
          },
          "No userReferralStats row to decrement; skipping",
        );
        continue;
      }

      const newReferrals = Math.max(0, stats.totalReferrals - count);
      const newPendingRaw = new Decimal(stats.totalRewardsPending.toString()).minus(amount);
      const newPending = newPendingRaw.lessThan(0) ? new Decimal(0) : newPendingRaw;

      await tx.userReferralStats.update({
        where: { userId: referrerUserId },
        data: {
          totalReferrals: newReferrals,
          totalRewardsPending: newPending,
        },
      });
    }
  }

  private buildExistingDiscountClaimFilter(userId: string): Prisma.BookingWhereInput {
    return {
      userId,
      status: {
        in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.ACTIVE],
      },
      OR: [
        // Settled uses of the discount — cannot be released.
        {
          referralStatus: {
            in: [BookingReferralStatus.APPLIED, BookingReferralStatus.REWARDED],
          },
        },
        // Reserved on a booking that is mid-payment or already paid. RESERVED + UNPAID
        // is intentionally excluded here because a new booking attempt releases it.
        {
          referralStatus: BookingReferralStatus.RESERVED,
          paymentStatus: { not: PaymentStatus.UNPAID },
        },
      ],
    };
  }

  private async releaseStaleReferralReservationsForUser(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const stale = await tx.booking.findMany({
      where: {
        userId,
        referralStatus: BookingReferralStatus.RESERVED,
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
      },
      select: { id: true },
    });

    for (const { id } of stale) {
      await this.releaseReferralReservation(tx, id);
    }
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
      "REFERRAL_DISCOUNT_AMOUNT",
      "REFERRAL_RELEASE_CONDITION",
    ]);

    const rewardAmount = this.parseDecimalConfig(
      rewardConfigMap.REFERRAL_REWARD_AMOUNT ??
        rewardConfigMap.REFERRAL_DISCOUNT_AMOUNT ??
        referralEligibility.discountAmount,
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
