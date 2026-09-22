import { Injectable } from "@nestjs/common";
import {
  BookingReferralStatus,
  BookingStatus,
  type BookingType,
  PaymentStatus,
  Prisma,
  type ReferralProgram,
  ReferralRewardStatus,
} from "@prisma/client";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import { ReferralProgramService } from "../referral/referral-program.service";
import { ReferralDiscountNoLongerAvailableException } from "./booking.error";
import type { ReferralEligibility } from "./booking.interface";

/**
 * Stored on `ReferralReward.reason` when a PENDING reward is tombstoned by
 * `releaseReferralReservation`. Distinct from `referral-processing.service.ts`
 * reversal reasons so audit logs can tell apart "user abandoned checkout" from
 * "release condition failed downstream".
 */
const RELEASED_RESERVATION_REASON = "RESERVATION_RELEASED";

type ReferralCreditReader = Pick<Prisma.TransactionClient, "$queryRaw" | "referralReward">;

@Injectable()
export class BookingEligibilityService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly referralProgramService: ReferralProgramService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingEligibilityService.name);
  }

  private getIneligibleReferralEligibility(): ReferralEligibility {
    return {
      eligible: false,
      referrerUserId: null,
      discountAmount: new Decimal(0),
      rewardAmount: new Decimal(0),
    };
  }

  async checkReferralEligibilityForPricing(
    sessionUser: AuthSession["user"] | null,
    bookingAmount: Decimal,
    bookingType: BookingType,
    carOwnerId: string,
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

    const program = await this.referralProgramService.getActiveProgram();
    if (!program) {
      return this.getIneligibleReferralEligibility();
    }

    const existingReserved = await this.databaseService.booking.findFirst({
      where: this.buildExistingDiscountClaimFilter(sessionUser.id),
      select: { id: true },
    });

    if (existingReserved) {
      return this.getIneligibleReferralEligibility();
    }

    if (
      user.referredByUserId === carOwnerId ||
      sessionUser.id === carOwnerId ||
      bookingAmount.lt(program.minimumBookingAmount)
    ) {
      return this.getIneligibleReferralEligibility();
    }

    if (!program.eligibleBookingTypes.includes(bookingType)) {
      return this.getIneligibleReferralEligibility();
    }

    if (program.referralValidityDays > 0 && user.referralSignupAt) {
      const expiryDate = new Date(user.referralSignupAt);
      expiryDate.setDate(expiryDate.getDate() + program.referralValidityDays);

      if (new Date() > expiryDate) {
        return this.getIneligibleReferralEligibility();
      }
    }

    return {
      eligible: true,
      referrerUserId: user.referredByUserId,
      discountAmount: this.referralProgramService.calculateRefereeDiscount(program, bookingAmount),
      rewardAmount: this.referralProgramService.calculateReferrerReward(program, bookingAmount),
    };
  }

  async getReferralCreditBalanceForPricing(
    sessionUser: AuthSession["user"] | null,
    bookingAmount: Decimal,
  ): Promise<Decimal> {
    if (!sessionUser) {
      return new Decimal(0);
    }
    const program = await this.referralProgramService.getProgram();
    return program
      ? this.getCappedReferralCreditBalance(
          this.databaseService,
          sessionUser.id,
          program,
          bookingAmount,
        )
      : new Decimal(0);
  }

  async verifyReferralCreditBalanceInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    requestedCredits: number,
    bookingAmount: Decimal,
  ): Promise<Decimal> {
    if (requestedCredits <= 0) {
      return new Decimal(0);
    }

    const program = await this.referralProgramService.getProgramForTransaction(tx);
    if (!program) {
      return new Decimal(0);
    }

    const users = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE
    `;
    if (!users[0]) {
      return new Decimal(0);
    }

    return this.getCappedReferralCreditBalance(tx, userId, program, bookingAmount);
  }

  async verifyAndReserveReferralDiscountInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    preliminaryEligibility: ReferralEligibility,
    bookingAmount: Decimal,
    bookingType: BookingType,
    carOwnerId: string,
  ): Promise<ReferralEligibility> {
    if (!preliminaryEligibility.eligible) {
      return preliminaryEligibility;
    }

    const program = await this.referralProgramService.getActiveProgramForTransaction(tx);
    if (!program) {
      throw new ReferralDiscountNoLongerAvailableException();
    }

    const users = await tx.$queryRaw<
      Array<{
        id: string;
        referredByUserId: string | null;
        referralDiscountUsed: boolean;
        referralSignupAt: Date | null;
      }>
    >`SELECT id, "referredByUserId", "referralDiscountUsed", "referralSignupAt" FROM "User" WHERE id = ${userId} FOR UPDATE`;

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

    if (
      freshUser.referredByUserId === carOwnerId ||
      userId === carOwnerId ||
      bookingAmount.lt(program.minimumBookingAmount) ||
      !program.eligibleBookingTypes.includes(bookingType)
    ) {
      throw new ReferralDiscountNoLongerAvailableException();
    }

    if (program.referralValidityDays > 0 && freshUser.referralSignupAt) {
      const expiryDate = new Date(freshUser.referralSignupAt);
      expiryDate.setDate(expiryDate.getDate() + program.referralValidityDays);
      if (new Date() > expiryDate) {
        throw new ReferralDiscountNoLongerAvailableException();
      }
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

    const verifiedEligibility = {
      eligible: true,
      referrerUserId: freshUser.referredByUserId,
      discountAmount: this.referralProgramService.calculateRefereeDiscount(program, bookingAmount),
      rewardAmount: this.referralProgramService.calculateReferrerReward(program, bookingAmount),
    };

    this.logger.info(
      {
        userId,
        discountAmount: verifiedEligibility.discountAmount.toString(),
        rewardAmount: verifiedEligibility.rewardAmount.toString(),
      },
      "Referral discount verified for booking reservation",
    );
    return verifiedEligibility;
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

    const reversedRewards = await this.reversePendingReferralRewards(
      tx,
      bookingId,
      RELEASED_RESERVATION_REASON,
    );

    this.logger.info({ bookingId, reversedRewards }, "Released referral reservation");

    return { released: true };
  }

  async reversePendingReferralRewards(
    tx: Prisma.TransactionClient,
    bookingId: string,
    reason: string,
  ): Promise<number> {
    const reversedRewards = await tx.referralReward.updateManyAndReturn({
      where: { bookingId, status: ReferralRewardStatus.PENDING },
      data: {
        status: ReferralRewardStatus.REVERSED,
        processedAt: new Date(),
        reason,
      },
      select: { referrerUserId: true, amount: true },
    });

    if (reversedRewards[0]) {
      await this.decrementReferralStatsForReversedReward(tx, reversedRewards[0]);
    }

    return reversedRewards.length;
  }

  private async decrementReferralStatsForReversedReward(
    tx: Prisma.TransactionClient,
    reward: { referrerUserId: string; amount: Decimal | Prisma.Decimal },
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT "id" FROM "User" WHERE "id" = ${reward.referrerUserId} FOR UPDATE
    `;
    const stats = await tx.userReferralStats.findUnique({
      where: { userId: reward.referrerUserId },
      select: { totalReferrals: true, totalRewardsPending: true },
    });
    if (!stats) {
      this.logger.warn(
        { referrerUserId: reward.referrerUserId },
        "No userReferralStats row to decrement; skipping",
      );
      return;
    }

    await tx.userReferralStats.update({
      where: { userId: reward.referrerUserId },
      data: {
        totalReferrals: Math.max(0, stats.totalReferrals - 1),
        totalRewardsPending: Decimal.max(
          0,
          new Decimal(stats.totalRewardsPending.toString()).minus(reward.amount.toString()),
        ),
      },
    });
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

    const rewardAmount = referralEligibility.rewardAmount;
    if (!rewardAmount.gt(0)) {
      return;
    }

    await tx.$queryRaw`
      SELECT "id" FROM "User"
      WHERE "id" = ${referralEligibility.referrerUserId}
      FOR UPDATE
    `;
    await tx.referralReward.create({
      data: {
        referrer: { connect: { id: referralEligibility.referrerUserId } },
        referee: { connect: { id: userId } },
        booking: { connect: { id: bookingId } },
        amount: rewardAmount,
        status: ReferralRewardStatus.PENDING,
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

  async reverseReferralRewardForRefund(
    tx: Prisma.TransactionClient,
    bookingId: string,
  ): Promise<{ reversed: boolean; manualRecoveryRequired: boolean }> {
    const rewards = await tx.$queryRaw<
      Array<{
        id: string;
        referrerUserId: string;
        amount: Prisma.Decimal;
        status: ReferralRewardStatus;
      }>
    >`SELECT "id", "referrerUserId", "amount", "status"
      FROM "ReferralReward"
      WHERE "bookingId" = ${bookingId}
      FOR UPDATE`;
    const reward = rewards[0];

    if (!reward || reward.status === ReferralRewardStatus.REVERSED) {
      return { reversed: false, manualRecoveryRequired: false };
    }

    if (reward.status === ReferralRewardStatus.PENDING) {
      const reversed = await this.reversePendingReferralRewards(tx, bookingId, "BOOKING_REFUNDED");
      return { reversed: reversed > 0, manualRecoveryRequired: false };
    }

    await tx.$queryRaw`
      SELECT "id" FROM "User" WHERE "id" = ${reward.referrerUserId} FOR UPDATE
    `;

    const { totalEarned, totalCommitted } = await this.getReferralCreditTotals(
      tx,
      reward.referrerUserId,
    );
    const remainingEarned = Decimal.max(0, totalEarned.minus(reward.amount));
    const manualRecoveryRequired = totalCommitted.gt(remainingEarned);
    const reason = manualRecoveryRequired
      ? "BOOKING_REFUNDED_CREDITS_ALREADY_USED"
      : "BOOKING_REFUNDED";

    const { count } = await tx.referralReward.updateMany({
      where: { id: reward.id, status: ReferralRewardStatus.RELEASED },
      data: {
        status: ReferralRewardStatus.REVERSED,
        processedAt: new Date(),
        reason,
      },
    });
    if (count === 0) {
      return { reversed: false, manualRecoveryRequired: false };
    }

    const stats = await tx.userReferralStats.findUnique({
      where: { userId: reward.referrerUserId },
      select: { totalReferrals: true, totalRewardsGranted: true },
    });
    if (stats) {
      await tx.userReferralStats.update({
        where: { userId: reward.referrerUserId },
        data: {
          totalReferrals: Math.max(0, stats.totalReferrals - 1),
          totalRewardsGranted: Decimal.max(
            0,
            new Decimal(stats.totalRewardsGranted.toString()).minus(reward.amount.toString()),
          ),
        },
      });
    }

    const logContext = {
      bookingId,
      referrerUserId: reward.referrerUserId,
      rewardAmount: reward.amount.toString(),
      recoveryShortfall: Decimal.max(0, totalCommitted.minus(remainingEarned)).toString(),
    };
    if (manualRecoveryRequired) {
      this.logger.error(logContext, "Referral reward refund clawback requires manual recovery");
    } else {
      this.logger.info(logContext, "Reversed released referral reward after refund");
    }

    return { reversed: true, manualRecoveryRequired };
  }

  private async getCappedReferralCreditBalance(
    database: ReferralCreditReader,
    userId: string,
    program: ReferralProgram,
    bookingAmount: Decimal,
  ): Promise<Decimal> {
    const { totalEarned, totalCommitted } = await this.getReferralCreditTotals(database, userId);
    const availableCredits = Decimal.max(0, totalEarned.minus(totalCommitted));
    return Decimal.min(
      availableCredits,
      this.referralProgramService.calculateCreditsCap(program, bookingAmount),
    );
  }

  private async getReferralCreditTotals(
    database: ReferralCreditReader,
    userId: string,
  ): Promise<{ totalEarned: Decimal; totalCommitted: Decimal }> {
    const [releasedRewards, committedCredits] = await Promise.all([
      database.referralReward.aggregate({
        where: {
          referrerUserId: userId,
          status: ReferralRewardStatus.RELEASED,
        },
        _sum: { amount: true },
      }),
      database.$queryRaw<Array<{ amount: Prisma.Decimal }>>`
        SELECT COALESCE(SUM(
          CASE
            WHEN "paymentStatus" IN (
              'PAID',
              'PARTIALLY_REFUNDED',
              'REFUND_PROCESSING',
              'REFUND_FAILED'
            )
              THEN "referralCreditsUsed"
            WHEN "paymentStatus" = 'UNPAID' AND "status" <> 'CANCELLED'
              THEN "referralCreditsReserved"
            ELSE 0
          END
        ), 0)::decimal AS amount
        FROM "Booking"
        WHERE "userId" = ${userId}
      `,
    ]);

    return {
      totalEarned: new Decimal(releasedRewards._sum.amount ?? 0),
      totalCommitted: new Decimal(committedCredits[0]?.amount ?? 0),
    };
  }
}
