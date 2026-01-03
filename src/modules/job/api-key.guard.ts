import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { timingSafeEqual } from "node:crypto";

/**
 * Guard that validates API key from request headers.
 *
 * Expects the API key in the `x-api-key` header.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * If API_KEY is not configured, the guard allows all requests (disabled).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly apiKey: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>("API_KEY");
  }

  canActivate(context: ExecutionContext): boolean {
    // If no API key configured, allow all requests
    if (!this.apiKey) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const providedKey = request.headers["x-api-key"];

    if (!providedKey || typeof providedKey !== "string") {
      throw new UnauthorizedException("Missing API key");
    }

    if (!this.isValidApiKey(providedKey)) {
      throw new UnauthorizedException("Invalid API key");
    }

    return true;
  }

  /**
   * Timing-safe comparison to prevent timing attacks
   */
  private isValidApiKey(providedKey: string): boolean {
    if (providedKey.length !== this.apiKey.length) {
      return false;
    }

    const providedBuffer = Buffer.from(providedKey);
    const expectedBuffer = Buffer.from(this.apiKey);

    return timingSafeEqual(providedBuffer, expectedBuffer);
  }
}
