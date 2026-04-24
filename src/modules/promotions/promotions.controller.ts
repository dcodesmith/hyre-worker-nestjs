import { Controller, Get, HttpCode, HttpStatus, Patch, Post, UseGuards } from "@nestjs/common";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { FLEET_OWNER } from "../auth/auth.types";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import {
  type CreatePromotionDto,
  createPromotionSchema,
  promotionIdParamSchema,
} from "./dto/promotion.dto";
import { PromotionsService } from "./promotions.service";

@Controller("api/fleet-owner/promotions")
@UseGuards(SessionGuard, RoleGuard)
@Roles(FLEET_OWNER)
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get()
  async getOwnerPromotions(@CurrentUser() sessionUser: AuthSession["user"]) {
    return this.promotionsService.getOwnerPromotions(sessionUser.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createPromotion(
    @ZodBody(createPromotionSchema) body: CreatePromotionDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    const promotionWindow = this.promotionsService.toPromotionWindowExclusive({
      startDate: body.startDate,
      endDateInclusive: body.endDate,
    });

    return this.promotionsService.createPromotion({
      ownerId: sessionUser.id,
      carId: body.carId ?? null,
      name: body.name || undefined,
      discountValue: body.discountValue,
      startDate: promotionWindow.startDate,
      endDate: promotionWindow.endDate,
    });
  }

  @Patch(":promotionId/deactivate")
  async deactivatePromotion(
    @ZodParam("promotionId", promotionIdParamSchema) promotionId: string,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.promotionsService.deactivatePromotion(promotionId, sessionUser.id);
  }
}
