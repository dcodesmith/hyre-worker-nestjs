import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { timingSafeSecretMatch } from "src/common/security/webhook-signature.helper";
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
    const secretValue = request.query?.secret;
    return typeof secretValue === "string" ? secretValue : null;
  }

  private verifySecret(received: string, expected: string): boolean {
    return timingSafeSecretMatch(received, expected, this.hmacKey);
  }
}
