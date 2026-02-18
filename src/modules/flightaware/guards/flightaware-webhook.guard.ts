import { createHmac, timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { EnvConfig } from "src/config/env.config";

@Injectable()
export class FlightAwareWebhookGuard implements CanActivate {
  private readonly logger = new Logger(FlightAwareWebhookGuard.name);
  private readonly webhookSecret: string;
  private readonly hmacKey: string;

  constructor(private readonly configService: ConfigService<EnvConfig>) {
    this.webhookSecret = this.configService.getOrThrow("FLIGHTAWARE_WEBHOOK_SECRET", {
      infer: true,
    });
    this.hmacKey = this.configService.getOrThrow("HMAC_KEY", {
      infer: true,
    });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const providedSecret = this.readSecretFromQuery(request);

    if (!providedSecret) {
      this.logger.warn("Missing FlightAware webhook secret");
      return false;
    }

    const isValid = this.verifySecret(providedSecret, this.webhookSecret);

    if (!isValid) {
      this.logger.warn("Invalid FlightAware webhook secret");
    }

    return isValid;
  }

  private readSecretFromQuery(request: Request): string | null {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    return url.searchParams.get("secret");
  }

  private verifySecret(received: string, expected: string): boolean {
    // Hash both values with createHmac(..., this.hmacKey) so timingSafeEqual always compares
    // fixed-length digests instead of variable-length user input.
    const receivedHash = createHmac("sha256", this.hmacKey).update(received).digest();
    const expectedHash = createHmac("sha256", this.hmacKey).update(expected).digest();

    return timingSafeEqual(receivedHash, expectedHash);
  }
}
