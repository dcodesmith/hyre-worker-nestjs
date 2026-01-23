import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { AUTH_SESSION_KEY, AuthSession } from "../guards/session.guard";

/**
 * Parameter decorator to extract the current user from the request.
 *
 * Must be used with SessionGuard to ensure the session is validated first.
 *
 * Usage:
 * ```typescript
 * @UseGuards(SessionGuard)
 * @Get('profile')
 * getProfile(@CurrentUser() user: AuthSession['user']) {
 *   return user;
 * }
 *
 * // Or get the full session
 * @Get('session')
 * getSession(@CurrentUser('session') session: AuthSession) {
 *   return session;
 * }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (data: "user" | "session" | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request & { [AUTH_SESSION_KEY]?: AuthSession }>();
    const authSession = request[AUTH_SESSION_KEY];

    if (!authSession) {
      return null;
    }

    if (data === "session") {
      return authSession;
    }

    // Default: return user
    return authSession.user;
  },
);
