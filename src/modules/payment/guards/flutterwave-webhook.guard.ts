import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { timingSafeSecretMatch } from "src/common/security/webhook-signature.helper";
import { EnvConfig } from "src/config/env.config";

/**
 * Guard to verify Flutterwave webhook signatures.
 *
 * Flutterwave sends a `verif-hash` header with each webhook request
 * that should match our configured webhook secret.
 *
 * @see https://developer.flutterwave.com/docs/integration-guides/webhooks
 */
@Injectable()
export class FlutterwaveWebhookGuard implements CanActivate {
  private readonly logger = new Logger(FlutterwaveWebhookGuard.name);
  private readonly webhookSecret: string;
  private readonly hmacKey: string;

  constructor(private readonly configService: ConfigService<EnvConfig>) {
    this.webhookSecret = this.configService.get("FLUTTERWAVE_WEBHOOK_SECRET", {
      infer: true,
    });
    this.hmacKey = this.configService.get("HMAC_KEY", {
      infer: true,
    });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const signature = request.headers["verif-hash"];

    if (!signature || typeof signature !== "string") {
      this.logger.warn("Missing verif-hash header in webhook request");
      return false;
    }

    if (!this.webhookSecret) {
      this.logger.error("FLUTTERWAVE_WEBHOOK_SECRET not configured");
      return false;
    }

    const isValid = this.verifySignature(signature, this.webhookSecret);

    if (!isValid) {
      this.logger.warn("Invalid webhook signature", {
        receivedLength: signature.length,
        expectedLength: this.webhookSecret.length,
      });
    }

    return isValid;
  }

  /**
   * Verify the webhook signature using timing-safe comparison.
   *
   * Uses HMAC to hash both values before comparison, ensuring:
   * - Constant-time comparison regardless of input length (no length oracle)
   * - Fixed-size buffers for timingSafeEqual
   *
   * This prevents timing attacks that could leak information about the secret.
   */
  private verifySignature(received: string, expected: string): boolean {
    return timingSafeSecretMatch(received, expected, this.hmacKey);
  }
}
