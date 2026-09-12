import { Controller, Get, HttpCode, HttpStatus, Patch, Post, UseGuards } from "@nestjs/common";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { ADMIN, STAFF } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { AddonsService } from "./addons.service";
import {
  addonIdParamSchema,
  addonPriceIdParamSchema,
  type CreateAddonDto,
  type CreateAddonPriceDto,
  createAddonPriceSchema,
  createAddonSchema,
  type UpdateAddonDto,
  updateAddonSchema,
} from "./dto/addons.dto";

@Controller("api/admin/addons")
@UseGuards(SessionGuard, RoleGuard)
@Roles(ADMIN, STAFF)
export class AdminAddonsController {
  constructor(private readonly addonsService: AddonsService) {}

  @Get()
  list() {
    return this.addonsService.listAdmin();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @ZodBody(createAddonSchema) dto: CreateAddonDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.addonsService.create(dto, user.id);
  }

  @Patch(":addonId")
  update(
    @ZodParam("addonId", addonIdParamSchema) addonId: string,
    @ZodBody(updateAddonSchema) dto: UpdateAddonDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.addonsService.update(addonId, dto, user.id);
  }

  @Post(":addonId/prices")
  @HttpCode(HttpStatus.CREATED)
  createPrice(
    @ZodParam("addonId", addonIdParamSchema) addonId: string,
    @ZodBody(createAddonPriceSchema) dto: CreateAddonPriceDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.addonsService.createPrice(addonId, dto, user.id);
  }

  @Patch(":addonId/prices/:priceId/end")
  endPrice(
    @ZodParam("addonId", addonIdParamSchema) addonId: string,
    @ZodParam("priceId", addonPriceIdParamSchema) priceId: string,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.addonsService.endPrice(addonId, priceId, user.id);
  }
}
