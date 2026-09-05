import { Injectable } from "@nestjs/common";
import {
  BookingReferralStatus,
  Prisma,
  ReferralReleaseCondition,
  ReferralRewardStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import { ReferralRewardReleasedHandler } from "../notification/handlers/referral-reward-released.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import { loadReferralProgramConfig } from "./referral-program-config";

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

  /**
   * Process referral release for a completed booking when configured for COMPLETED.
   * - Checks global referral config and idempotency
   * - Optionally enforces expiry window
   * - Marks referee discount as used
   * - Releases pending reward and updates stats
   * - Sets booking.referralStatus = REWARDED
   */
  async processReferralCompletionForBooking(bookingId: string) {
    const config = await loadReferralProgramConfig(this.databaseService.referralProgramConfig);

    if (!config.enabled || config.releaseCondition !== "COMPLETED") {
      this.logger.info(
        {
          REFERRAL_ENABLED: config.enabled,
          REFERRAL_RELEASE_CONDITION: config.releaseCondition,
        },
        "Skipping referral completion due to config",
      );
      return;
    }

    const booking = await this.databaseService.booking.findFirst({
      where: { id: bookingId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        referralReferrerUserId: true,
        referralStatus: true,
      },
    });

    if (
      booking?.referralStatus !== BookingReferralStatus.APPLIED ||
      !booking?.userId ||
      !booking?.referralReferrerUserId
    ) {
      this.logger.info(
        {
          bookingId,
          hasBooking: !!booking,
          referralStatus: booking?.referralStatus,
          hasUser: !!booking?.userId,
          hasReferrer: !!booking?.referralReferrerUserId,
        },
        "Skipping referral completion: booking not eligible",
      );
      return;
    }

    try {
      await this.databaseService.$transaction(async (tx) => {
        // Idempotency: skip if already released
        const alreadyReleased = await tx.referralReward.findFirst({
          where: { bookingId: booking.id, status: ReferralRewardStatus.RELEASED },
          select: { id: true },
        });

        if (alreadyReleased) {
          this.logger.warn(
            {
              bookingId: booking.id,
              rewardId: alreadyReleased.id,
            },
            "Referral reward already released for booking",
          );
          return;
        }

        // Optional expiry check
        const referee = await tx.user.findUnique({
          where: { id: booking.userId },
          select: { referralSignupAt: true, referralDiscountUsed: true },
        });

        if (config.expiryDays > 0 && referee?.referralSignupAt) {
          const daysSinceSignup = Math.floor(
            (Date.now() - referee.referralSignupAt.getTime()) / (1000 * 60 * 60 * 24),
          );

          if (daysSinceSignup > config.expiryDays) {
            this.logger.warn(
              {
                bookingId: booking.id,
                userId: booking.userId,
                daysSinceSignup,
                expiryDays: config.expiryDays,
              },
              "Referral expired before completion; not releasing reward",
            );
            return;
          }
        }

        // Mark discount used if not already. This is a fallback for bookings
        // confirmed before the payment confirmation path marked the discount used.
        if (referee && !referee.referralDiscountUsed) {
          await tx.user.update({
            where: { id: booking.userId },
            data: { referralDiscountUsed: true },
          });

          this.logger.info(
            {
              bookingId: booking.id,
              userId: booking.userId,
            },
            "Referral discount marked as used on completion (fallback)",
          );
        }

        // Release pending reward
        const pendingReward = await tx.referralReward.findFirst({
          where: {
            bookingId: booking.id,
            status: ReferralRewardStatus.PENDING,
            releaseCondition: ReferralReleaseCondition.COMPLETED,
          },
        });

        if (!pendingReward) {
          this.logger.info(
            {
              bookingId: booking.id,
            },
            "No pending referral reward found for booking",
          );
          return;
        }

        const releasedAt = new Date();
        const released = await tx.referralReward.updateMany({
          where: {
            id: pendingReward.id,
            status: ReferralRewardStatus.PENDING,
            releaseCondition: ReferralReleaseCondition.COMPLETED,
          },
          data: { status: ReferralRewardStatus.RELEASED, processedAt: releasedAt },
        });
        if (released.count === 0) {
          return;
        }

        await tx.booking.update({
          where: { id: booking.id },
          data: { referralStatus: BookingReferralStatus.REWARDED },
        });

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

        this.logger.info(
          {
            bookingId: booking.id,
            rewardId: pendingReward.id,
            rewardAmount: pendingReward.amount,
            referrerId: pendingReward.referrerUserId,
          },
          "Referral reward released on completion",
        );
      });
    } catch (error) {
      this.logger.error(
        {
          bookingId: booking.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to process referral completion",
      );
      throw error;
    }
  }
}
