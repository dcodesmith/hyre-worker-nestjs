import { Injectable } from "@nestjs/common";
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
import { ReferralApiService } from "./referral-api.service";
import { ReferralProcessingService } from "./referral-processing.service";

@Injectable()
export class ReferralService {
  constructor(
    private readonly referralApiService: ReferralApiService,
    private readonly referralProcessingService: ReferralProcessingService,
  ) {}

  async queueReferralProcessing(bookingId: string): Promise<void> {
    return this.referralProcessingService.queueReferralProcessing(bookingId);
  }

  async processReferralCompletionForBooking(bookingId: string) {
    return this.referralProcessingService.processReferralCompletionForBooking(bookingId);
  }

  async validateReferralCode(code: string, query: ValidateReferralQueryDto) {
    try {
      const referrer = await this.referralApiService.validateReferralCode(code, query.email);
      return {
        valid: true,
        referrer: {
          name: referrer.name ?? "Anonymous",
        },
        message: "Valid referral code.",
      };
    } catch (error) {
      if (error instanceof ReferralException) {
        throw error;
      }
      throw new ReferralValidationFailedException();
    }
  }

  async getReferralEligibility(userId: string, query: ReferralEligibilityQueryDto) {
    try {
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
    } catch (error) {
      if (error instanceof ReferralException) {
        throw error;
      }
      throw new ReferralEligibilityCheckFailedException();
    }
  }

  async getCurrentUserReferralInfo(userId: string, request: Request) {
    try {
      const origin = getRequestOrigin(request);
      const referralInfo = await this.referralApiService.getUserReferralSummary(userId, origin);

      if (!referralInfo) {
        throw new ReferralUserNotFoundException();
      }

      return referralInfo;
    } catch (error) {
      if (error instanceof ReferralException) {
        throw error;
      }
      throw new ReferralUserFetchFailedException();
    }
  }
}
