import type { IncomingHttpHeaders } from "node:http";
import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "../auth.service";
import { AUTH_SESSION_KEY, type AuthSession } from "./session.guard";

/**
 * Converts Express IncomingHttpHeaders to a Headers object.
 */
function toHeaders(incomingHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

/**
 * Guard that optionally validates user session via Better Auth.
 *
 * Unlike SessionGuard, this guard does NOT throw when no session is present.
 * It allows both authenticated and unauthenticated (guest) requests through.
 *
 * - If valid session exists: attaches session to request, @CurrentUser returns user
 * - If no session: allows request through, @CurrentUser returns null
 * - If auth service not initialized: allows request through (logs warning)
 *
 * Usage:
 * ```typescript
 * @UseGuards(OptionalSessionGuard)
 * @Post('bookings')
 * createBooking(
 *   @Body() dto: CreateBookingDto,
 *   @CurrentUser() user: AuthSession['user'] | null,
 * ) {
 *   // user is null for guest bookings
 * }
 * ```
 */
@Injectable()
export class OptionalSessionGuard implements CanActivate {
  private readonly logger = new Logger(OptionalSessionGuard.name);

  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // If auth service is not initialized, allow request through (guest mode)
    if (!this.authService.isInitialized) {
      this.logger.warn(
        "Authentication service not initialized. All requests will be treated as guest requests.",
      );
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    try {
      const session = await this.authService.auth.api.getSession({
        headers: toHeaders(request.headers),
      });

      if (!session) {
        // No session - allow through as guest (don't throw)
        return true;
      }

      // Fetch user roles from database
      const roles = await this.authService.getUserRoles(session.user.id);

      // Attach session with roles to request for use by @CurrentUser decorator
      const authSession: AuthSession = {
        user: { ...session.user, roles },
        session: session.session,
      };
      (request as Request & { [AUTH_SESSION_KEY]: AuthSession })[AUTH_SESSION_KEY] = authSession;
    } catch (error) {
      // If session validation fails (e.g., expired token), treat as guest
      this.logger.debug("Session validation failed, treating as guest request", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return true;
  }
}
