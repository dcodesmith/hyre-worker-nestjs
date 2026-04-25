import type { IncomingHttpHeaders } from "node:http";
import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import type { Session, User } from "better-auth";
import type { Request } from "express";
import { AuthErrorCode, AuthUnauthorizedException } from "../auth.error";
import type { RoleName } from "../auth.interface";
import { AuthService } from "../auth.service";

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

function isInvalidSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /invalid|expired|unauthorized|session/i.test(error.message);
}

export const AUTH_SESSION_KEY = "authSession";

export interface AuthSession {
  user: User & { roles: RoleName[] };
  session: Session;
}

/**
 * Guard that validates user session via Better Auth.
 *
 * Supports both cookie-based (web) and bearer token (mobile) authentication.
 * Attaches the session to the request object for use by the @CurrentUser decorator.
 *
 * Usage:
 * ```typescript
 * @UseGuards(SessionGuard)
 * @Get('profile')
 * getProfile(@CurrentUser() user: AuthSession['user']) {
 *   return user;
 * }
 * ```
 */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly logger = new Logger(SessionGuard.name);

  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const auth = this.authService.auth;
    let session: Awaited<ReturnType<typeof this.authService.auth.api.getSession>> = null;
    try {
      session = await auth.api.getSession({
        headers: toHeaders(request.headers),
      });
    } catch (error) {
      if (isInvalidSessionError(error)) {
        throw new AuthUnauthorizedException(
          AuthErrorCode.AUTH_INVALID_OR_EXPIRED_SESSION,
          "Invalid or expired session",
          "Invalid Or Expired Session",
        );
      }

      this.logger.error(
        "Unexpected error while validating auth session",
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }

    if (!session) {
      throw new AuthUnauthorizedException(
        AuthErrorCode.AUTH_INVALID_OR_EXPIRED_SESSION,
        "Invalid or expired session",
        "Invalid Or Expired Session",
      );
    }

    // Fetch user roles from database
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
