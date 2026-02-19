import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { OptionalSessionGuard } from "../auth/guards/optional-session.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import type { CreateBookingResponse, CreateExtensionResponse } from "./booking.interface";
import { BookingCreationService } from "./booking-creation.service";
import { BookingExtensionService } from "./booking-extension.service";
import { ValidatedBookingBody } from "./decorators/validated-booking-body.decorator";
import type { CreateBookingInput } from "./dto/create-booking.dto";
import {
  bookingIdParamSchema,
  type CreateExtensionBodyDto,
  createExtensionBodySchema,
} from "./dto/create-extension.dto";

/**
 * Controller for booking-related API endpoints.
 *
 * Supports both authenticated users and guest bookings on the same endpoint.
 * The OptionalSessionGuard makes the session optional - if a valid session exists,
 * the user is attached to the request; otherwise, the request proceeds as a guest.
 */
@Controller("api/bookings")
export class BookingController {
  constructor(
    private readonly bookingCreationService: BookingCreationService,
    private readonly bookingExtensionService: BookingExtensionService,
  ) {}

  /**
   * Create a new booking.
   *
   * Supports both authenticated users and guests:
   * - Authenticated users: session is validated, user info from profile
   * - Guests: no session required, must provide guestEmail, guestName, guestPhone
   *
   * The @ValidatedBookingBody decorator automatically selects the correct schema
   * (createBookingSchema vs createGuestBookingSchema) based on authentication status.
   *
   * @returns Booking ID and checkout URL for payment
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(OptionalSessionGuard)
  async createBooking(
    @ValidatedBookingBody() booking: CreateBookingInput,
    @CurrentUser() sessionUser: AuthSession["user"] | null,
  ): Promise<CreateBookingResponse> {
    return this.bookingCreationService.createBooking(booking, sessionUser);
  }

  @Post(":bookingId/extensions")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionGuard)
  async createExtension(
    @ZodParam("bookingId", bookingIdParamSchema) bookingId: string,
    @ZodBody(createExtensionBodySchema) body: CreateExtensionBodyDto,
    @CurrentUser() sessionUser: AuthSession["user"] | null | undefined,
  ): Promise<CreateExtensionResponse> {
    if (!sessionUser) {
      throw new UnauthorizedException("Invalid or expired session");
    }
    return this.bookingExtensionService.createExtension(bookingId, body, sessionUser);
  }
}
