import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { BookingReferralStatus, ReferralRewardStatus } from "@prisma/client";
import { Queue } from "bullmq";
import { REFERRAL_QUEUE } from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import { PROCESS_REFERRAL_COMPLETION, ReferralJobData } from "./referral.interface";

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    @InjectQueue(REFERRAL_QUEUE)
    private readonly referralQueue: Queue<ReferralJobData>,
  ) {}

  /**
   * Queue a referral completion job for async processing
   */
  async queueReferralProcessing(bookingId: string): Promise<void> {
    try {
      await this.referralQueue.add(PROCESS_REFERRAL_COMPLETION, {
        bookingId,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Queued referral processing for booking ${bookingId}`);
    } catch (error) {
      this.logger.error("Failed to queue referral processing", {
        bookingId,
        error: error instanceof Error ? error.message : String(error),
      });
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
      this.logger.warn("Invalid REFERRAL_RELEASE_CONDITION value", {
        value: REFERRAL_RELEASE_CONDITION,
      });
      return;
    }

    const REFERRAL_EXPIRY_DAYS = Number(configMap.REFERRAL_EXPIRY_DAYS ?? 0);

    if (!REFERRAL_ENABLED || REFERRAL_RELEASE_CONDITION !== "COMPLETED") {
      this.logger.log("Skipping referral completion due to config", {
        REFERRAL_ENABLED,
        REFERRAL_RELEASE_CONDITION,
      });
      return;
    }

    const booking = await this.databaseService.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        userId: true,
        referralReferrerUserId: true,
        referralStatus: true,
      },
    });

    if (
      !booking ||
      booking.referralStatus !== BookingReferralStatus.APPLIED ||
      !booking.userId ||
      !booking.referralReferrerUserId
    ) {
      this.logger.log("Skipping referral completion: booking not eligible", {
        bookingId,
        hasBooking: !!booking,
        referralStatus: booking?.referralStatus,
        hasUser: !!booking?.userId,
        hasReferrer: !!booking?.referralReferrerUserId,
      });
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
          this.logger.warn("Referral reward already released for booking", {
            bookingId: booking.id,
            rewardId: alreadyReleased.id,
          });
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
            this.logger.warn("Referral expired before completion; not releasing reward", {
              bookingId: booking.id,
              userId: booking.userId,
              daysSinceSignup,
              expiryDays: REFERRAL_EXPIRY_DAYS,
            });
            return;
          }
        }

        // Mark discount used if not already
        if (referee && !referee.referralDiscountUsed) {
          await tx.user.update({
            where: { id: booking.userId },
            data: { referralDiscountUsed: true },
          });

          this.logger.log("Referral discount marked as used on completion", {
            bookingId: booking.id,
            userId: booking.userId,
          });
        }

        // Release pending reward
        const pendingReward = await tx.referralReward.findFirst({
          where: { bookingId: booking.id, status: ReferralRewardStatus.PENDING },
        });

        if (!pendingReward) {
          this.logger.log("No pending referral reward found for booking", {
            bookingId: booking.id,
          });
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

        await tx.userReferralStats.upsert({
          where: { userId: pendingReward.referrerUserId },
          create: {
            userId: pendingReward.referrerUserId,
            totalReferrals: 0,
            totalRewardsGranted: pendingReward.amount,
            totalRewardsPending: 0,
            lastReferralAt: new Date(),
          },
          update: {
            totalRewardsGranted: { increment: pendingReward.amount },
            totalRewardsPending: { decrement: pendingReward.amount },
            lastReferralAt: new Date(),
          },
        });

        this.logger.log("Referral reward released on completion", {
          bookingId: booking.id,
          rewardId: pendingReward.id,
          rewardAmount: pendingReward.amount,
          referrerId: pendingReward.referrerUserId,
        });
      });
    } catch (error) {
      this.logger.error("Failed to process referral completion", {
        bookingId: booking.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - allow graceful degradation
    }
  }
}
