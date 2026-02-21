import { Controller, Get, HttpCode, HttpStatus, Patch, Post, UseGuards } from "@nestjs/common";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { ADMIN } from "../auth/auth.types";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import {
  addonRateIdParamSchema,
  type CreateAddonRateDto,
  type CreatePlatformFeeDto,
  type CreateVatRateDto,
  createAddonRateSchema,
  createPlatformFeeSchema,
  createVatRateSchema,
} from "./dto/rates-admin.dto";
import { RatesAdminService } from "./rates-admin.service";

@Controller("api/rates")
@UseGuards(SessionGuard, RoleGuard)
@Roles(ADMIN)
export class RatesController {
  constructor(private readonly ratesAdminService: RatesAdminService) {}

  @Get()
  async getAllRates() {
    return this.ratesAdminService.getAllRates();
  }

  @Post("platform-fee")
  @HttpCode(HttpStatus.CREATED)
  async createPlatformFeeRate(@ZodBody(createPlatformFeeSchema) dto: CreatePlatformFeeDto) {
    return this.ratesAdminService.createPlatformFeeRate(dto);
  }

  @Post("vat")
  @HttpCode(HttpStatus.CREATED)
  async createVatRate(@ZodBody(createVatRateSchema) dto: CreateVatRateDto) {
    return this.ratesAdminService.createVatRate(dto);
  }

  @Post("addon")
  @HttpCode(HttpStatus.CREATED)
  async createAddonRate(@ZodBody(createAddonRateSchema) dto: CreateAddonRateDto) {
    return this.ratesAdminService.createAddonRate(dto);
  }

  @Patch("addon/:addonRateId/end")
  async endAddonRate(@ZodParam("addonRateId", addonRateIdParamSchema) addonRateId: string) {
    return this.ratesAdminService.endAddonRate(addonRateId);
  }
}
