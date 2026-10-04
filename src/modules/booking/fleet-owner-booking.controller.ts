import { Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ZodBody, ZodParam, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { FLEET_OWNER } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { VerifiedFleetOwnerGuard } from "../auth/guards/verified-fleet-owner.guard";
import { BookingUpdateService } from "./booking-update.service";
import {
  type AssignBookingChauffeurBodyDto,
  assignBookingChauffeurBodySchema,
} from "./dto/assign-chauffeur.dto";
import { bookingIdParamSchema } from "./dto/create-extension.dto";
import {
  type FleetOwnerBookingsQueryDto,
  fleetOwnerBookingsQuerySchema,
} from "./dto/fleet-owner-bookings.dto";
import { FleetOwnerBookingReadService } from "./fleet-owner-booking-read.service";

@Controller("api/fleet-owner/bookings")
@UseGuards(SessionGuard, RoleGuard, VerifiedFleetOwnerGuard)
@Roles(FLEET_OWNER)
export class FleetOwnerBookingController {
  constructor(
    private readonly bookingReadService: FleetOwnerBookingReadService,
    private readonly bookingUpdateService: BookingUpdateService,
  ) {}

  @Get()
  list(
    @ZodQuery(fleetOwnerBookingsQuerySchema) query: FleetOwnerBookingsQueryDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.bookingReadService.list(sessionUser.id, query);
  }

  @Get(":bookingId")
  get(
    @ZodParam("bookingId", bookingIdParamSchema) bookingId: string,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.bookingReadService.get(sessionUser.id, bookingId);
  }

  @Patch(":bookingId/chauffeur")
  async assignChauffeur(
    @ZodParam("bookingId", bookingIdParamSchema) bookingId: string,
    @ZodBody(assignBookingChauffeurBodySchema) body: AssignBookingChauffeurBodyDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.bookingUpdateService.assignChauffeur(bookingId, sessionUser.id, body.chauffeurId);
  }
}
