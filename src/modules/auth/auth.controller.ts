import type { IncomingHttpHeaders } from "node:http";
import {
  All,
  Controller,
  Get,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { toNodeHandler } from "better-auth/node";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";

/**
 * Converts Express IncomingHttpHeaders to a Headers object.
 * Normalizes string[] values to comma-separated strings and skips undefined values.
 */
function toHeaders(incomingHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Catch-all handler for Better Auth endpoints.
   * Routes all /auth/api/* requests to Better Auth.
   *
   * Note: We use @Res() here because Better Auth needs direct access
   * to the response object to handle cookies and headers.
   */
  @All("api/*path")
  async handleAuthRequest(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.ensureAuthInitialized();

    const handler = toNodeHandler(this.authService.auth);
    await handler(req, res);
  }

  /**
   * Get current session information.
   * Returns session data if authenticated, 401 if not.
   */
  @Get("session")
  async getSession(@Req() req: Request): Promise<{ user: unknown; session: unknown }> {
    this.ensureAuthInitialized();

    const session = await this.authService.auth.api.getSession({
      headers: toHeaders(req.headers),
    });

    if (!session) {
      throw new UnauthorizedException("Not authenticated");
    }

    return session;
  }

  /**
   * Throws ServiceUnavailableException if auth is not configured.
   */
  private ensureAuthInitialized(): void {
    if (!this.authService.isInitialized) {
      throw new ServiceUnavailableException(
        "Authentication service is not configured. Contact support.",
      );
    }
  }
}
