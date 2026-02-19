import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import twilio from "twilio";
import type { EnvConfig } from "../../../config/env.config";

@Injectable()
export class TwilioWebhookGuard implements CanActivate {
  private readonly logger = new Logger(TwilioWebhookGuard.name);
  private readonly authToken: string | undefined;
  private readonly webhookUrl: string | undefined;

  constructor(private readonly configService: ConfigService<EnvConfig>) {
    this.authToken = this.configService.get("TWILIO_AUTH_TOKEN", { infer: true });
    this.webhookUrl = this.configService.get("TWILIO_WEBHOOK_URL", { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const signature = this.getSignature(request);

    if (!signature) {
      this.logger.warn("Missing Twilio signature header");
      return false;
    }

    if (!this.webhookUrl) {
      this.logger.error("Twilio webhook configuration is missing");
      return false;
    }

    const params = this.normalizeBodyParams(request.body);
    const isValid = twilio.validateRequest(this.authToken, signature, this.webhookUrl, params);

    if (!isValid) {
      this.logger.warn("Invalid Twilio webhook signature");
    }

    return isValid;
  }

  private getSignature(request: Request): string | null {
    const signature = request.headers["x-twilio-signature"];
    return typeof signature === "string" ? signature : null;
  }

  private normalizeBodyParams(body: unknown): Record<string, string> {
    if (!body || typeof body !== "object") {
      return {};
    }

    return Object.entries(body as Record<string, unknown>).reduce<Record<string, string>>(
      (acc, [key, value]) => {
        if (value === null || value === undefined) {
          return acc;
        }

        if (Array.isArray(value)) {
          acc[key] = value.map(String).join(",");
          return acc;
        }

        acc[key] = String(value);
        return acc;
      },
      {},
    );
  }
}
