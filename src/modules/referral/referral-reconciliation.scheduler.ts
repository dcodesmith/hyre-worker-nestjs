import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  BookingReferralStatus,
  BookingStatus,
  PaymentStatus,
  ReferralReleaseCondition,
  ReferralRewardStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import { ReferralProcessingService } from "./referral-processing.service";

const RECONCILIATION_BATCH_SIZE = 100;
const RECONCILIATION_RETRY_BACKOFF_MS = 15 * 60 * 1000;

@Injectable()
export class ReferralReconciliationScheduler {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly referralProcessingService: ReferralProcessingService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReferralReconciliationScheduler.name);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcilePendingRewards(): Promise<void> {
    const now = new Date();
    const retryBefore = new Date(now.getTime() - RECONCILIATION_RETRY_BACKOFF_MS);
    const claimableAttempt = {
      OR: [
        { reconciliationLastAttemptAt: null },
        { reconciliationLastAttemptAt: { lte: retryBefore } },
      ],
    };

    try {
      const configs = await this.databaseService.referralProgramConfig.findMany({
        where: {
          key: {
            in: ["REFERRAL_ENABLED", "REFERRAL_RELEASE_CONDITION", "REFERRAL_EXPIRY_DAYS"],
          },
        },
        select: { key: true, value: true },
      });
      const config = Object.fromEntries(configs.map(({ key, value }) => [key, value]));
      const enabled = config.REFERRAL_ENABLED ?? true;
      const releaseCondition = config.REFERRAL_RELEASE_CONDITION ?? "COMPLETED";
      const expiryDays = Number(config.REFERRAL_EXPIRY_DAYS ?? 0);
      if (!enabled || releaseCondition !== ReferralReleaseCondition.COMPLETED) {
        return;
      }

      const rewards = await this.databaseService.referralReward.findMany({
        where: {
          status: ReferralRewardStatus.PENDING,
          releaseCondition: ReferralReleaseCondition.COMPLETED,
          ...claimableAttempt,
          booking: {
            is: {
              deletedAt: null,
              status: BookingStatus.COMPLETED,
              paymentStatus: PaymentStatus.PAID,
              referralStatus: BookingReferralStatus.APPLIED,
            },
          },
          ...(expiryDays > 0
            ? {
                referee: {
                  is: {
                    OR: [
                      { referralSignupAt: null },
                      {
                        referralSignupAt: {
                          gt: new Date(now.getTime() - expiryDays * 24 * 60 * 60 * 1000),
                        },
                      },
                    ],
                  },
                },
              }
            : {}),
        },
        select: { bookingId: true },
        distinct: ["bookingId"],
        orderBy: [
          { reconciliationLastAttemptAt: { sort: "asc", nulls: "first" } },
          { createdAt: "asc" },
        ],
        take: RECONCILIATION_BATCH_SIZE,
      });
      if (rewards.length === RECONCILIATION_BATCH_SIZE) {
        this.logger.warn(
          { batchSize: RECONCILIATION_BATCH_SIZE },
          "Referral reward reconciliation batch is saturated",
        );
      }
      const reconciliationBucket = Math.floor(now.getTime() / RECONCILIATION_RETRY_BACKOFF_MS);
      let enqueued = 0;
      let failed = 0;
      let skipped = 0;

      for (const reward of rewards) {
        const claimed = await this.databaseService.referralReward.updateMany({
          where: {
            bookingId: reward.bookingId,
            status: ReferralRewardStatus.PENDING,
            releaseCondition: ReferralReleaseCondition.COMPLETED,
            ...claimableAttempt,
          },
          data: { reconciliationLastAttemptAt: now },
        });
        if (claimed.count === 0) {
          skipped += 1;
          continue;
        }

        try {
          await this.referralProcessingService.queueReferralProcessing(
            reward.bookingId,
            `referral-reconcile-${reward.bookingId}-${reconciliationBucket}`,
          );
          enqueued += 1;
        } catch (error) {
          failed += 1;
          this.logger.error(
            {
              bookingId: reward.bookingId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to requeue pending referral reward",
          );
        }
      }

      this.logger.info(
        { found: rewards.length, enqueued, failed, skipped },
        "Reconciled pending referral rewards",
      );
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to reconcile pending referral rewards",
      );
    }
  }
}
