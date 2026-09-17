import { Controller, Get, HttpCode, HttpStatus, Patch, Post, UseGuards } from "@nestjs/common";
import { ZodBody, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { ADMIN, STAFF } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import {
  type CreateReferralProgramDto,
  createReferralProgramSchema,
  type ReferralProgramHistoryQueryDto,
  referralProgramHistoryQuerySchema,
  type UpdateReferralProgramDto,
  updateReferralProgramSchema,
} from "./dto/referral-program.dto";
import { ReferralProgramService } from "./referral-program.service";

@Controller("api/admin/referral-program")
@UseGuards(SessionGuard, RoleGuard)
@Roles(ADMIN, STAFF)
export class AdminReferralProgramController {
  constructor(private readonly referralProgramService: ReferralProgramService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @ZodBody(createReferralProgramSchema) dto: CreateReferralProgramDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.referralProgramService.create(dto, user.id);
  }

  @Get()
  get() {
    return this.referralProgramService.get();
  }

  @Patch()
  update(
    @ZodBody(updateReferralProgramSchema) dto: UpdateReferralProgramDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.referralProgramService.update(dto, user.id);
  }

  @Get("history")
  history(
    @ZodQuery(referralProgramHistoryQuerySchema)
    query: ReferralProgramHistoryQueryDto,
  ) {
    return this.referralProgramService.history(query);
  }
}
