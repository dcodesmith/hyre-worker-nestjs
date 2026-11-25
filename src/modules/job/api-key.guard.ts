import { createHash, timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";

/**
 * Guard that validates API key from request headers.
 *
 * Expects the API key in the `x-api-key` header.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * Fails closed when API_KEY is not configured.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly apiKey: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>("API_KEY");
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.apiKey) {
      throw new UnauthorizedException("API key authentication is not configured");
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
   * Timing-safe comparison using fixed-length SHA-256 digests so neither
   * length differences nor multi-byte UTF-8 inputs leak timing or throw RangeError.
   */
  private isValidApiKey(providedKey: string): boolean {
    const providedDigest = createHash("sha256").update(providedKey).digest();
    const expectedDigest = createHash("sha256").update(this.apiKey).digest();

    return timingSafeEqual(providedDigest, expectedDigest);
  }
}
