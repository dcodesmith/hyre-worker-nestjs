import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import { PinoLogger } from "nestjs-pino";
import { getRequestOrigin } from "../../common/http/request.helper";
import type { ReferralEligibilityQueryDto, ValidateReferralQueryDto } from "./dto/referral.dto";
import {
  ReferralEligibilityCheckFailedException,
  ReferralException,
  ReferralUserFetchFailedException,
  ReferralUserNotFoundException,
  ReferralValidationFailedException,
} from "./referral.error";
import { ReferralApiService } from "./referral-api.service";

@Injectable()
export class ReferralService {
  constructor(
    private readonly referralApiService: ReferralApiService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReferralService.name);
  }

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
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        `Unhandled referral error in ${operationName}`,
      );
      throw fallback();
    }
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
    const referralInfo = await this.withReferralExceptionBoundary(
      async () => this.referralApiService.getUserReferralSummary(userId, requestOrigin),
      () => new ReferralUserFetchFailedException(),
      "getCurrentUserReferralInfo",
    );

    if (!referralInfo) {
      throw new ReferralUserNotFoundException();
    }

    return referralInfo;
  }
}
