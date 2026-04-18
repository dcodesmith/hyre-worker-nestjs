import { Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { LAGOS_TIMEZONE } from "../../shared/timezone";
import { FLEET_OWNER } from "../auth/auth.types";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import {
  type CreatePromotionBodyDto,
  createPromotionBodySchema,
  promotionIdParamSchema,
} from "./dto/promotion.dto";
import { PromotionService } from "./promotion.service";

@Controller("api/fleet-owner/promotions")
@UseGuards(SessionGuard, RoleGuard)
@Roles(FLEET_OWNER)
export class FleetOwnerPromotionController {
  constructor(private readonly promotionService: PromotionService) {}

  @Get()
  async listOwnerPromotions(@CurrentUser() sessionUser: AuthSession["user"]) {
    return this.promotionService.getOwnerPromotions(sessionUser.id);
  }

  @Post()
  async createPromotion(
    @ZodBody(createPromotionBodySchema) body: CreatePromotionBodyDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    const { startDate, endDate } = PromotionService.toPromotionWindowExclusive({
      startDate: body.startDate,
      endDateInclusive: body.endDate,
      timeZone: LAGOS_TIMEZONE,
    });

    return this.promotionService.createPromotion({
      ownerId: sessionUser.id,
      carId: body.scope === "FLEET" ? null : (body.carId ?? null),
      name: body.name,
      discountValue: body.discountValue,
      startDate,
      endDate,
    });
  }

  @Post(":promotionId/deactivate")
  @HttpCode(HttpStatus.OK)
  async deactivatePromotion(
    @ZodParam("promotionId", promotionIdParamSchema) promotionId: string,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.promotionService.deactivatePromotion(promotionId, sessionUser.id);
  }
}
