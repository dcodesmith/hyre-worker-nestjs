import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AUTH_SESSION_KEY, type AuthSession } from "../../auth/guards/session.guard";
import { BookingValidationException } from "../booking.error";
import {
  type CreateBookingInput,
  createBookingSchema,
  createGuestBookingSchema,
} from "../dto/create-booking.dto";

// Extend Express Request type to include custom properties from guards
interface RequestWithAuthSession extends Request {
  [AUTH_SESSION_KEY]?: AuthSession;
}

// Reuse pipe instances to avoid creating new objects on every request
const authenticatedPipe = new ZodValidationPipe(createBookingSchema, {
  exceptionFactory: (errors) => new BookingValidationException(errors),
});
const guestPipe = new ZodValidationPipe(createGuestBookingSchema, {
  exceptionFactory: (errors) => new BookingValidationException(errors),
});

/**
 * Custom parameter decorator that validates booking input with the appropriate schema
 * based on authentication status.
 *
 * Usage:
 * ```typescript
 * @Post()
 * @UseGuards(OptionalSessionGuard)
 * async createBooking(
 *   @ValidatedBookingBody() booking: CreateBookingInput,
 *   @CurrentUser() user: AuthSession["user"] | null,
 * ) { ... }
 * ```
 */
export const ValidatedBookingBody = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CreateBookingInput => {
    const request = ctx.switchToHttp().getRequest<RequestWithAuthSession>();

    // Check if user is authenticated (attached by OptionalSessionGuard via AUTH_SESSION_KEY)
    const authSession = request[AUTH_SESSION_KEY];
    const isAuthenticated = authSession !== null && authSession !== undefined;

    // Select appropriate pipe based on authentication status
    const pipe = isAuthenticated ? authenticatedPipe : guestPipe;

    // Validate and transform
    return pipe.transform(request.body);
  },
);
