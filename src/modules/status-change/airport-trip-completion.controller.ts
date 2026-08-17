import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { BookingCompletionSource } from "@prisma/client";
import { z } from "zod";
import { ZodBody, ZodParam, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { ADMIN, FLEET_OWNER, STAFF } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { BookingNotFoundException } from "../booking/booking.error";
import { hashBookingCompletionToken } from "../booking/booking-completion-token.helper";
import { bookingIdParamSchema } from "../booking/dto/create-extension.dto";
import {
  renderAirportCompletionInvalidPage,
  renderAirportCompletionPage,
} from "./airport-trip-completion.page";
import { StatusChangeService } from "./status-change.service";

const completionTokenQuerySchema = z.object({
  token: z.string().min(1).optional(),
});
type CompletionTokenQuery = z.infer<typeof completionTokenQuerySchema>;

@Controller("chauffeur/airport-trips")
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class AirportTripCompletionPageController {
  private readonly logger = new Logger(AirportTripCompletionPageController.name);

  constructor(private readonly statusChangeService: StatusChangeService) {}

  @Get(":bookingId/complete")
  @Header("Content-Type", "text/html; charset=utf-8")
  async showCompletionPage(
    @ZodParam("bookingId", bookingIdParamSchema) bookingId: string,
    @ZodQuery(completionTokenQuerySchema) query: CompletionTokenQuery,
  ) {
    return this.renderPage(bookingId, query.token, "show");
  }

  @Post(":bookingId/complete")
  @HttpCode(HttpStatus.OK)
  @Header("Content-Type", "text/html; charset=utf-8")
  async completeFromPage(
    @ZodParam("bookingId", bookingIdParamSchema) bookingId: string,
    @ZodBody(completionTokenQuerySchema) body: CompletionTokenQuery,
  ) {
    return this.renderPage(bookingId, body.token, "complete");
  }

  private async renderPage(
    bookingId: string,
    token: string | undefined,
    action: "show" | "complete",
  ) {
    if (!token) {
      return renderAirportCompletionInvalidPage();
    }
    try {
      const booking =
        action === "complete"
          ? await this.statusChangeService.completeAirportBookingWithToken(
              bookingId,
              hashBookingCompletionToken(token),
            )
          : await this.statusChangeService.getAirportCompletionDetails(
              bookingId,
              hashBookingCompletionToken(token),
            );
      return renderAirportCompletionPage(booking, token);
    } catch (error) {
      if (error instanceof BookingNotFoundException) {
        return renderAirportCompletionInvalidPage();
      }
      this.logger.error(
        `Airport completion page failed unexpectedly for booking ${bookingId} (${action})`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }
}

@Controller("api/fleet-owner/bookings")
@UseGuards(SessionGuard, RoleGuard)
export class FleetOwnerAirportTripCompletionController {
  constructor(private readonly statusChangeService: StatusChangeService) {}

  @Patch(":bookingId/airport-completion")
  @Roles(FLEET_OWNER, ADMIN, STAFF)
  completeTrip(
    @ZodParam("bookingId", bookingIdParamSchema) bookingId: string,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    const isOperations = sessionUser.roles.includes(ADMIN) || sessionUser.roles.includes(STAFF);
    return this.statusChangeService.completeAirportBookingForUser(
      bookingId,
      sessionUser.id,
      isOperations ? BookingCompletionSource.OPERATIONS : BookingCompletionSource.FLEET_OWNER,
    );
  }
}
