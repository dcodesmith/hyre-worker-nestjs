import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { Command, CommandRunner, Option } from "nest-commander";
import twilio from "twilio";
import type { EnvConfig } from "../config/env.config";

interface CliOptions {
  webhookUrl?: string;
  baseUrl?: string;
  from?: string;
  to?: string;
  waid?: string;
  body?: string;
  messageSid?: string;
  numMedia?: string;
}

@Injectable()
@Command({
  name: "wa:webhook:test",
  description: "Send a signed Twilio-style inbound webhook request",
})
export class WhatsAppWebhookTestCommand extends CommandRunner {
  private readonly logger = new Logger(WhatsAppWebhookTestCommand.name);

  constructor(private readonly configService: ConfigService<EnvConfig>) {
    super();
  }

  async run(_inputs: string[], options: CliOptions): Promise<void> {
    const authToken = this.configService.get("TWILIO_AUTH_TOKEN", { infer: true });
    const configuredWebhookUrl = this.configService.get("TWILIO_WEBHOOK_URL", { infer: true });
    const webhookUrl =
      options.webhookUrl ??
      (options.baseUrl
        ? `${options.baseUrl.replace(/\/$/, "")}/api/whatsapp-agent/webhook/twilio`
        : undefined) ??
      configuredWebhookUrl;

    if (!webhookUrl) {
      throw new Error(
        "Webhook URL is required. Use --webhook-url, --base-url, or set TWILIO_WEBHOOK_URL.",
      );
    }

    const from = options.from;
    if (!from) {
      throw new Error("Missing --from (example: whatsapp:+2348012345678)");
    }

    const configuredToNumber = this.configService.get("TWILIO_WHATSAPP_NUMBER", { infer: true });
    const to = options.to ?? (configuredToNumber ? `whatsapp:${configuredToNumber}` : undefined);

    if (!to) {
      throw new Error("Missing --to and TWILIO_WHATSAPP_NUMBER is not configured");
    }

    const waid = options.waid ?? from.replace(/^whatsapp:\+?/i, "").replaceAll(/[^\d]/g, "");

    if (!waid) {
      throw new Error("Missing --waid and could not derive one from --from");
    }

    const body = options.body ?? "Webhook test from Nest command";
    const messageSid = options.messageSid ?? `SM${Date.now()}${Math.floor(Math.random() * 10_000)}`;
    const numMedia = options.numMedia ?? "0";

    const params: Record<string, string> = {
      MessageSid: messageSid,
      From: from,
      To: to,
      WaId: waid,
      Body: body,
      NumMedia: numMedia,
    };

    const signature = twilio.getExpectedTwilioSignature(authToken, webhookUrl, params);
    const payload = new URLSearchParams(params);

    this.logger.log(`POST ${webhookUrl}`);
    const response = await axios.post<string>(webhookUrl, payload.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      timeout: 15_000,
      validateStatus: () => true,
    });

    this.logger.log(`Status: ${response.status}`);
    if (typeof response.data === "string") {
      this.logger.log(`Response body: ${response.data}`);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Webhook call failed with status ${response.status}`);
    }
  }

  @Option({
    flags: "--webhook-url [url]",
    description: "Full webhook URL (overrides base-url and env)",
  })
  parseWebhookUrl(value: string): string {
    return value;
  }

  @Option({
    flags: "--base-url [url]",
    description: "Base URL; auto-appends /api/whatsapp-agent/webhook/twilio",
  })
  parseBaseUrl(value: string): string {
    return value;
  }

  @Option({
    flags: "--from [value]",
    description: "Inbound sender, e.g. whatsapp:+2348012345678",
  })
  parseFrom(value: string): string {
    return value;
  }

  @Option({
    flags: "--to [value]",
    description: "Destination number, e.g. whatsapp:+14155238886",
  })
  parseTo(value: string): string {
    return value;
  }

  @Option({
    flags: "--waid [value]",
    description: "WhatsApp sender ID digits",
  })
  parseWaid(value: string): string {
    return value;
  }

  @Option({
    flags: "--body [text]",
    description: "Message body",
  })
  parseBody(value: string): string {
    return value;
  }

  @Option({
    flags: "--message-sid [sid]",
    description: "Custom MessageSid",
  })
  parseMessageSid(value: string): string {
    return value;
  }

  @Option({
    flags: "--num-media [count]",
    description: "NumMedia value (default: 0)",
  })
  parseNumMedia(value: string): string {
    return value;
  }
}
