import { Injectable, Logger } from "@nestjs/common";
import type { Request } from "express";
import { getRequestOrigin } from "../../common/http/request.helper";
import type { ReferralEligibilityQueryDto, ValidateReferralQueryDto } from "./dto/referral.dto";
import {
  ReferralEligibilityCheckFailedException,
  ReferralException,
  ReferralUserFetchFailedException,
  ReferralUserNotFoundException,
  ReferralValidationFailedException,
} from "./referral.error";
import type { ReferralUserSummaryResponse } from "./referral.interface";
import { ReferralApiService } from "./referral-api.service";
import { ReferralProcessingService } from "./referral-processing.service";

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);
  private readonly userSummaryTtlMs = 30 * 1000;
  private readonly maxPruneChecksPerWrite = 25;
  private readonly userSummaryCache = new Map<
    string,
    {
      value: ReferralUserSummaryResponse;
      expiresAt: number;
    }
  >();

  constructor(
    private readonly referralApiService: ReferralApiService,
    private readonly referralProcessingService: ReferralProcessingService,
  ) {}

  private async withReferralExceptionBoundary<T>(
    operation: () => Promise<T>,
    fallback: () => ReferralException,
    operationName: string,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ReferralException) {
        throw error;
      }
      this.logger.error(`Unhandled referral error in ${operationName}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw fallback();
    }
  }

  private pruneExpiredUserSummaryCache(
    now: number,
    maxEntriesToScan = this.userSummaryCache.size,
  ): void {
    let scanned = 0;
    for (const [key, entry] of this.userSummaryCache.entries()) {
      if (entry.expiresAt <= now) {
        this.userSummaryCache.delete(key);
      }

      scanned += 1;
      if (scanned >= maxEntriesToScan) {
        break;
      }
    }
  }

  async queueReferralProcessing(bookingId: string): Promise<void> {
    return this.referralProcessingService.queueReferralProcessing(bookingId);
  }

  async processReferralCompletionForBooking(bookingId: string) {
    return this.referralProcessingService.processReferralCompletionForBooking(bookingId);
  }

  async validateReferralCode(code: string, query: ValidateReferralQueryDto) {
    return this.withReferralExceptionBoundary(
      async () => {
        const referrer = await this.referralApiService.validateReferralCode(code, query.email);
        return {
          valid: true,
          referrer: {
            name: referrer.name ?? "Anonymous",
          },
          message: "Valid referral code.",
        };
      },
      () => new ReferralValidationFailedException(),
      "validateReferralCode",
    );
  }

  async getReferralEligibility(userId: string, query: ReferralEligibilityQueryDto) {
    return this.withReferralExceptionBoundary(
      async () => {
        const eligibility = await this.referralApiService.checkReferralEligibility(
          userId,
          query.amount,
          query.type,
        );

        return {
          eligible: eligibility.eligible,
          discountAmount: eligibility.discountAmount || 0,
          reason: eligibility.reason,
        };
      },
      () => new ReferralEligibilityCheckFailedException(),
      "getReferralEligibility",
    );
  }

  async getCurrentUserReferralInfo(userId: string, request: Request) {
    const requestOrigin = getRequestOrigin(request);
    const cacheKey = `${userId}:${requestOrigin ?? "unknown-origin"}`;
    const now = Date.now();
    const cached = this.userSummaryCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > now) {
        return cached.value;
      }

      this.userSummaryCache.delete(cacheKey);
    }

    const referralInfo = await this.withReferralExceptionBoundary(
      async () => this.referralApiService.getUserReferralSummary(userId, requestOrigin),
      () => new ReferralUserFetchFailedException(),
      "getCurrentUserReferralInfo",
    );

    if (!referralInfo) {
      throw new ReferralUserNotFoundException();
    }

    this.userSummaryCache.set(cacheKey, {
      value: referralInfo,
      expiresAt: now + this.userSummaryTtlMs,
    });
    this.pruneExpiredUserSummaryCache(now, this.maxPruneChecksPerWrite);

    return referralInfo;
  }
}
