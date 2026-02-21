import type { IncomingHttpHeaders } from "node:http";
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Session, User } from "better-auth";
import type { Request } from "express";
import { AuthService } from "../auth.service";
import type { RoleName } from "../auth.types";

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
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.authService.isInitialized) {
      throw new ServiceUnavailableException(
        "Authentication service is not configured. Contact support.",
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    let session: Awaited<ReturnType<typeof this.authService.auth.api.getSession>> = null;
    try {
      session = await this.authService.auth.api.getSession({
        headers: toHeaders(request.headers),
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired session");
    }

    if (!session) {
      throw new UnauthorizedException("Invalid or expired session");
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
