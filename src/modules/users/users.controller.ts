import { Controller, Get, HttpCode, HttpStatus, Patch, Post, UseGuards } from "@nestjs/common";
import { ZodBody } from "../../common/decorators/zod-validation.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { type AuthSession, SessionGuard } from "../auth/guards/session.guard";
import {
  type CheckPhoneVerificationDto,
  checkPhoneVerificationSchema,
  type SendPhoneVerificationDto,
  sendPhoneVerificationSchema,
} from "../verification/account-verification.dto";
import { PhoneVerificationService } from "../verification/phone-verification.service";
import { VerificationThrottlerGuard } from "../verification/verification-throttler.guard";
import {
  type UpdateCurrentUserBodyDto,
  updateCurrentUserBodySchema,
} from "./dto/update-current-user.dto";
import type { CurrentUserProfile } from "./users.interface";
import { UsersService } from "./users.service";

@Controller("api/users/me")
@UseGuards(SessionGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly phoneVerificationService: PhoneVerificationService,
  ) {}

  @Get()
  async getCurrentUserProfile(
    @CurrentUser() user: AuthSession["user"],
  ): Promise<CurrentUserProfile> {
    return this.usersService.getCurrentUserProfile(user.id);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  async updateCurrentUserProfile(
    @CurrentUser() user: AuthSession["user"],
    @ZodBody(updateCurrentUserBodySchema) body: UpdateCurrentUserBodyDto,
  ): Promise<CurrentUserProfile> {
    return this.usersService.updateCurrentUserProfile(user.id, body);
  }

  @Post("phone-verifications")
  @UseGuards(VerificationThrottlerGuard)
  sendPhoneVerification(
    @CurrentUser() user: AuthSession["user"],
    @ZodBody(sendPhoneVerificationSchema) body: SendPhoneVerificationDto,
  ) {
    return this.phoneVerificationService.send(user.id, body);
  }

  @Post("phone-verification-checks")
  @UseGuards(VerificationThrottlerGuard)
  checkPhoneVerification(
    @CurrentUser() user: AuthSession["user"],
    @ZodBody(checkPhoneVerificationSchema) body: CheckPhoneVerificationDto,
  ) {
    return this.phoneVerificationService.check(user.id, body);
  }
}
