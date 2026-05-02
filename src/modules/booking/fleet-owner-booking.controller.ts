import { Controller, Patch, UseGuards } from "@nestjs/common";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { FLEET_OWNER } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { BookingUpdateService } from "./booking-update.service";
import {
  type AssignBookingChauffeurBodyDto,
  assignBookingChauffeurBodySchema,
} from "./dto/assign-chauffeur.dto";
import { bookingIdParamSchema } from "./dto/create-extension.dto";

@Controller("api/fleet-owner/bookings")
@UseGuards(SessionGuard, RoleGuard)
@Roles(FLEET_OWNER)
export class FleetOwnerBookingController {
  constructor(private readonly bookingUpdateService: BookingUpdateService) {}

  @Patch(":bookingId/chauffeur")
  async assignChauffeur(
    @ZodParam("bookingId", bookingIdParamSchema) bookingId: string,
    @ZodBody(assignBookingChauffeurBodySchema) body: AssignBookingChauffeurBodyDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.bookingUpdateService.assignChauffeur(bookingId, sessionUser.id, body.chauffeurId);
  }
}
