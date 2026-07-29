import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { PinoLogger } from "nestjs-pino";
import {
  createHmacSignature,
  timingSafeSecretMatch,
} from "src/common/security/webhook-signature.helper";
import type { EnvConfig } from "src/config/env.config";

@Injectable()
export class FlightAwareWebhookGuard implements CanActivate {
  private readonly webhookSecret: string;
  private readonly hmacKey: string;

  constructor(
    private readonly configService: ConfigService<EnvConfig>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FlightAwareWebhookGuard.name);
    this.webhookSecret = this.configService.getOrThrow("FLIGHTAWARE_WEBHOOK_SECRET", {
      infer: true,
    });
    this.hmacKey = this.configService.getOrThrow("HMAC_KEY", {
      infer: true,
    });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const flightId = this.readQueryValue(request, "flightId");
    const providedSignature = this.readQueryValue(request, "signature");

    if (!flightId || !providedSignature) {
      this.logger.warn("Missing FlightAware webhook signature");
      return false;
    }

    const expectedSignature = createHmacSignature(flightId, this.webhookSecret);
    const isValid = timingSafeSecretMatch(providedSignature, expectedSignature, this.hmacKey);

    if (!isValid) {
      this.logger.warn("Invalid FlightAware webhook signature");
    }

    return isValid;
  }

  private readQueryValue(request: Request, key: string): string | null {
    const value = request.query?.[key];
    return typeof value === "string" ? value : null;
  }
}
