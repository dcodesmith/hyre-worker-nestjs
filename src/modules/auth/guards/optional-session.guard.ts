import type { IncomingHttpHeaders } from "node:http";
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
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
 * Checks if the request contains any authentication credentials.
 * Returns true if Authorization header or session cookie is present.
 */
function hasAuthCredentials(request: Request): boolean {
  // Check for Authorization header (Bearer token)
  if (request.headers.authorization) {
    return true;
  }

  // Check for session cookie
  // Better Auth uses session_token cookie with optional __Host- prefix:
  // - Production (HTTPS): __Host-session_token
  // - Development (HTTP): session_token
  const cookieHeader = request.headers.cookie;
  if (cookieHeader) {
    const hasSessionCookie =
      cookieHeader.includes("session_token") || // Matches both "session_token" and "__Host-session_token"
      cookieHeader.includes("session_data"); // Matches both "session_data" and "__Host-session_data"
    if (hasSessionCookie) {
      return true;
    }
  }

  return false;
}

/**
 * Guard that optionally validates user session via Better Auth.
 *
 * Unlike SessionGuard, this guard allows guest (unauthenticated) requests through,
 * but ONLY when no auth credentials are provided. If credentials are provided
 * but invalid/expired, it throws UnauthorizedException to prevent silent downgrade.
 *
 * Behavior:
 * - No auth credentials: allows through as guest, @CurrentUser returns null
 * - Valid session: attaches session to request, @CurrentUser returns user
 * - Credentials provided but invalid/expired: throws UnauthorizedException
 * - Auth service not initialized: allows through as guest (logs warning)
 *
 * This prevents the dangerous scenario where a user thinks they're logged in
 * (has a cookie) but their session expired, causing their booking to be created
 * as a guest without account association, referral benefits, or history visibility.
 *
 * Usage:
 * ```typescript
 * @UseGuards(OptionalSessionGuard)
 * @Post('bookings')
 * createBooking(
 *   @Body() dto: CreateBookingDto,
 *   @CurrentUser() user: AuthSession['user'] | null,
 * ) {
 *   // user is null for intentional guest bookings (no credentials provided)
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
    const credentialsProvided = hasAuthCredentials(request);

    // If no auth credentials provided, this is an intentional guest request
    if (!credentialsProvided) {
      return true;
    }

    // Auth credentials were provided - user intends to be authenticated
    // If validation fails, we should NOT silently downgrade to guest
    const session = await this.authService.auth.api.getSession({
      headers: toHeaders(request.headers),
    });

    if (!session) {
      // User provided credentials but session is invalid/expired
      // Don't silently downgrade to guest - inform them to re-authenticate
      throw new UnauthorizedException(
        "Your session has expired or is invalid. Please log in again.",
      );
    }

    // Fetch user roles from database
    // NOTE: If this fails, we let the error propagate rather than silently
    // downgrading an authenticated user to guest mode (which would cause loss
    // of referral discounts and booking history visibility)
    const roles = await this.authService.getUserRoles(session.user.id);

    // Attach session with roles to request for use by @CurrentUser decorator
    const authSession: AuthSession = {
      user: { ...session.user, roles },
      session: session.session,
    };
    (request as Request & { [AUTH_SESSION_KEY]: AuthSession })[AUTH_SESSION_KEY] = authSession;

    return true;
  }
}
