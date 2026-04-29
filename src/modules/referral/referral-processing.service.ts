import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { BookingReferralStatus, Prisma, ReferralRewardStatus } from "@prisma/client";
import { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { REFERRAL_QUEUE } from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import { PROCESS_REFERRAL_COMPLETION, ReferralJobData } from "./referral.interface";

@Injectable()
export class ReferralProcessingService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
    @InjectQueue(REFERRAL_QUEUE)
    private readonly referralQueue: Queue<ReferralJobData>,
  ) {
    this.logger.setContext(ReferralProcessingService.name);
  }

  /**
   * Queue a referral completion job for async processing
   */
  async queueReferralProcessing(bookingId: string): Promise<void> {
    try {
      await this.referralQueue.add(PROCESS_REFERRAL_COMPLETION, {
        bookingId,
        timestamp: new Date().toISOString(),
      });

      this.logger.info(`Queued referral processing for booking ${bookingId}`);
    } catch (error) {
      this.logger.error(
        {
          bookingId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to queue referral processing",
      );
      throw error;
    }
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
    // Load config
    const configs = await this.databaseService.referralProgramConfig.findMany();
    const configMap = configs.reduce<Record<string, unknown>>((acc, c) => {
      acc[c.key] = c.value;
      return acc;
    }, {});

    const REFERRAL_ENABLED = configMap.REFERRAL_ENABLED ?? true;
    const REFERRAL_RELEASE_CONDITION = (configMap.REFERRAL_RELEASE_CONDITION ?? "COMPLETED") as
      | "PAID"
      | "COMPLETED";

    if (REFERRAL_RELEASE_CONDITION !== "PAID" && REFERRAL_RELEASE_CONDITION !== "COMPLETED") {
      this.logger.warn(
        {
          value: REFERRAL_RELEASE_CONDITION,
        },
        "Invalid REFERRAL_RELEASE_CONDITION value",
      );
      return;
    }

    const REFERRAL_EXPIRY_DAYS = Number(configMap.REFERRAL_EXPIRY_DAYS ?? 0);

    if (!REFERRAL_ENABLED || REFERRAL_RELEASE_CONDITION !== "COMPLETED") {
      this.logger.info(
        {
          REFERRAL_ENABLED,
          REFERRAL_RELEASE_CONDITION,
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

        if (REFERRAL_EXPIRY_DAYS > 0 && referee?.referralSignupAt) {
          const daysSinceSignup = Math.floor(
            (Date.now() - referee.referralSignupAt.getTime()) / (1000 * 60 * 60 * 24),
          );

          if (daysSinceSignup > REFERRAL_EXPIRY_DAYS) {
            this.logger.warn(
              {
                bookingId: booking.id,
                userId: booking.userId,
                daysSinceSignup,
                expiryDays: REFERRAL_EXPIRY_DAYS,
              },
              "Referral expired before completion; not releasing reward",
            );
            return;
          }
        }

        // Mark discount used if not already.
        // Note: This is a fallback for bookings created before the race condition fix.
        // New bookings set referralDiscountUsed=true during booking creation (in the same transaction)
        // to prevent concurrent bookings from all receiving the one-time discount.
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
          where: { bookingId: booking.id, status: ReferralRewardStatus.PENDING },
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

        await tx.referralReward.update({
          where: { id: pendingReward.id },
          data: { status: ReferralRewardStatus.RELEASED, processedAt: new Date() },
        });

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
      // Don't throw - allow graceful degradation
    }
  }
}
