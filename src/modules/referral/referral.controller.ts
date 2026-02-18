import { Controller, Get, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodParam, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { type AuthSession, SessionGuard } from "../auth/guards/session.guard";
import {
  type ReferralEligibilityQueryDto,
  referralCodeParamSchema,
  referralEligibilityQuerySchema,
  type ValidateReferralQueryDto,
  validateReferralQuerySchema,
} from "./dto/referral.dto";
import { ReferralService } from "./referral.service";
import { ReferralThrottlerGuard } from "./referral-throttler.guard";

@Controller("api/referrals")
export class ReferralController {
  constructor(private readonly referralService: ReferralService) {}

  @Get("validate/:code")
  @UseGuards(SessionGuard, ReferralThrottlerGuard)
  async validateReferralCode(
    @ZodParam("code", referralCodeParamSchema) code: string,
    @ZodQuery(validateReferralQuerySchema) query: ValidateReferralQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "no-store");
    return this.referralService.validateReferralCode(code, query);
  }

  @Get("eligibility")
  @UseGuards(SessionGuard)
  async getReferralEligibility(
    @CurrentUser() user: AuthSession["user"],
    @ZodQuery(referralEligibilityQuerySchema) query: ReferralEligibilityQueryDto,
  ) {
    return this.referralService.getReferralEligibility(user.id, query);
  }

  @Get("user")
  @UseGuards(SessionGuard)
  async getCurrentUserReferralInfo(
    @CurrentUser() user: AuthSession["user"],
    @Req() request: Request,
  ) {
    return this.referralService.getCurrentUserReferralInfo(user.id, request);
  }
}
