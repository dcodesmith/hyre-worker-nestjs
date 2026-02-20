import { Controller, Get, UseGuards } from "@nestjs/common";
import { ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { FLEET_OWNER } from "../auth/auth.types";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { DashboardService } from "./dashboard.service";
import {
  type DashboardEarningsQueryDto,
  type DashboardPayoutsQueryDto,
  dashboardEarningsQuerySchema,
  dashboardPayoutsQuerySchema,
} from "./dto/dashboard.dto";

@Controller("api/dashboard")
@UseGuards(SessionGuard, RoleGuard)
@Roles(FLEET_OWNER)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get("overview")
  async getOverview(@CurrentUser() sessionUser: AuthSession["user"]) {
    return this.dashboardService.getOverview(sessionUser.id);
  }

  @Get("earnings")
  async getEarnings(
    @ZodQuery(dashboardEarningsQuerySchema) query: DashboardEarningsQueryDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.dashboardService.getEarnings(sessionUser.id, query);
  }

  @Get("payouts")
  async getPayouts(
    @ZodQuery(dashboardPayoutsQuerySchema) query: DashboardPayoutsQueryDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.dashboardService.getPayouts(sessionUser.id, query);
  }

  @Get("payouts/summary")
  async getPayoutSummary(@CurrentUser() sessionUser: AuthSession["user"]) {
    return this.dashboardService.getPayoutSummary(sessionUser.id);
  }
}
