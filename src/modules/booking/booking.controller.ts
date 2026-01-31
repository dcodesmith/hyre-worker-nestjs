import { Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { OptionalSessionGuard } from "../auth/guards/optional-session.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import type { CreateBookingResponse } from "./booking.interface";
import { BookingCreationService } from "./booking-creation.service";
import { ValidatedBookingBody } from "./decorators/validated-booking-body.decorator";
import type { CreateBookingInput } from "./dto/create-booking.dto";

/**
 * Controller for booking-related API endpoints.
 *
 * Supports both authenticated users and guest bookings on the same endpoint.
 * The OptionalSessionGuard makes the session optional - if a valid session exists,
 * the user is attached to the request; otherwise, the request proceeds as a guest.
 */
@Controller("api/bookings")
export class BookingController {
  constructor(private readonly bookingCreationService: BookingCreationService) {}

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
}
