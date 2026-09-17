import { Injectable } from "@nestjs/common";
import {
  BookingReferralStatus,
  BookingStatus,
  PaymentStatus,
  Prisma,
  ReferralRewardStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import { ReferralRewardReleasedHandler } from "../notification/handlers/referral-reward-released.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";

@Injectable()
export class ReferralProcessingService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly referralRewardReleasedHandler: ReferralRewardReleasedHandler,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReferralProcessingService.name);
  }

  async processReferralCompletionForBooking(bookingId: string) {
    try {
      const released = await this.databaseService.$transaction((tx) =>
        this.releaseEligibleReward(tx, bookingId, PaymentStatus.PAID),
      );

      this.logger.info(
        { bookingId, released },
        released
          ? "Referral reward released on completion"
          : "Referral completion skipped because booking or reward was not eligible",
      );
      return released;
    } catch (error) {
      this.logger.error(
        {
          bookingId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to process referral completion",
      );
      throw error;
    }
  }

  processReferralCompletionAfterFailedRefund(
    tx: Prisma.TransactionClient,
    bookingId: string,
  ): Promise<boolean> {
    return this.releaseEligibleReward(tx, bookingId, PaymentStatus.REFUND_FAILED);
  }

  private async releaseEligibleReward(
    tx: Prisma.TransactionClient,
    bookingId: string,
    requiredPaymentStatus: PaymentStatus,
  ): Promise<boolean> {
    await tx.$queryRaw`
      SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE
    `;
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        userId: true,
        status: true,
        paymentStatus: true,
        referralReferrerUserId: true,
        referralStatus: true,
        deletedAt: true,
      },
    });
    if (
      !booking ||
      booking.deletedAt ||
      booking.status !== BookingStatus.COMPLETED ||
      booking.paymentStatus !== requiredPaymentStatus ||
      booking.referralStatus !== BookingReferralStatus.APPLIED ||
      !booking.userId ||
      !booking.referralReferrerUserId
    ) {
      return false;
    }

    const pendingReward = await tx.referralReward.findUnique({
      where: { bookingId: booking.id },
    });
    if (!pendingReward || pendingReward.status !== ReferralRewardStatus.PENDING) {
      return false;
    }

    const releasedAt = new Date();
    const rewardUpdate = await tx.referralReward.updateMany({
      where: {
        id: pendingReward.id,
        status: ReferralRewardStatus.PENDING,
      },
      data: {
        status: ReferralRewardStatus.RELEASED,
        processedAt: releasedAt,
      },
    });
    if (rewardUpdate.count === 0) {
      return false;
    }

    const referee = await tx.user.findUnique({
      where: { id: booking.userId },
      select: { referralDiscountUsed: true },
    });
    if (referee && !referee.referralDiscountUsed) {
      await tx.user.update({
        where: { id: booking.userId },
        data: { referralDiscountUsed: true },
      });
    }

    await tx.booking.update({
      where: { id: booking.id },
      data: { referralStatus: BookingReferralStatus.REWARDED },
    });
    await tx.$queryRaw`
      SELECT "id" FROM "User" WHERE "id" = ${pendingReward.referrerUserId} FOR UPDATE
    `;

    const currentStats = await tx.userReferralStats.findUnique({
      where: { userId: pendingReward.referrerUserId },
      select: { totalRewardsPending: true },
    });
    const currentPending = new Prisma.Decimal(currentStats?.totalRewardsPending ?? 0);
    const computedPending = currentPending.minus(pendingReward.amount);
    const newPending = computedPending.lessThan(0) ? new Prisma.Decimal(0) : computedPending;

    await tx.userReferralStats.upsert({
      where: { userId: pendingReward.referrerUserId },
      create: {
        userId: pendingReward.referrerUserId,
        totalReferrals: 1,
        totalRewardsGranted: pendingReward.amount,
        totalRewardsPending: 0,
        lastReferralAt: new Date(),
      },
      update: {
        totalRewardsGranted: { increment: pendingReward.amount },
        totalRewardsPending: newPending,
        lastReferralAt: new Date(),
      },
    });

    await this.notificationOutboxService.create(
      this.referralRewardReleasedHandler,
      {
        rewardId: pendingReward.id,
        bookingId: booking.id,
        referrerUserId: pendingReward.referrerUserId,
        amount: Number(pendingReward.amount),
        releasedAt,
      },
      tx,
    );

    return true;
  }
}
