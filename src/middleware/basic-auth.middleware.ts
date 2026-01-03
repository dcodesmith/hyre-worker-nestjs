import { Injectable, NestMiddleware } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

/**
 * Basic Auth middleware for protecting routes like Bull Board.
 *
 * Prompts browser for username/password via HTTP Basic Authentication.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * If credentials are not configured, middleware is bypassed (disabled).
 */
@Injectable()
export class BasicAuthMiddleware implements NestMiddleware {
  private readonly username: string | undefined;
  private readonly password: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.username = this.configService.get<string>("BULL_BOARD_USERNAME");
    this.password = this.configService.get<string>("BULL_BOARD_PASSWORD");
  }

  use(req: Request, res: Response, next: NextFunction): void {
    // If credentials not configured, bypass auth
    if (!this.username || !this.password) {
      next();
      return;
    }

    const authHeader = req.get("authorization");

    if (!authHeader?.startsWith("Basic ")) {
      this.sendUnauthorizedResponse(res);
      return;
    }

    const encodedCreds = authHeader.split(" ")[1];
    const decodedCreds = Buffer.from(encodedCreds, "base64").toString("utf-8");
    const [username, password] = decodedCreds.split(":");

    if (!this.isValidCredentials(username, password)) {
      this.sendUnauthorizedResponse(res);
      return;
    }

    next();
  }

  private isValidCredentials(username: string, password: string): boolean {
    const validUsername = this.safeCompare(username, this.username);
    const validPassword = this.safeCompare(password, this.password);
    return validUsername && validPassword;
  }

  /**
   * Timing-safe string comparison to prevent timing attacks
   */
  private safeCompare(provided: string, expected: string): boolean {
    if (provided.length !== expected.length) {
      return false;
    }

    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);

    return timingSafeEqual(providedBuffer, expectedBuffer);
  }

  private sendUnauthorizedResponse(res: Response): void {
    res.setHeader("WWW-Authenticate", 'Basic realm="Bull Board", charset="UTF-8"');
    res.sendStatus(401);
  }
}
