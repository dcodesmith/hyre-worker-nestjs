import { ConfigService } from "@nestjs/config";
import { EnvConfig } from "src/config/env.config";

export function getFromAddress(configService: ConfigService<EnvConfig>): string {
  const appName = configService.get("APP_NAME", { infer: true });
  const senderName = configService.get("SENDER_NAME", { infer: true });
  const emailFrom = configService.get("EMAIL_FROM", { infer: true });
  const resendFromEmail = configService.get("RESEND_FROM_EMAIL", { infer: true });
  const fromEmail = emailFrom ?? resendFromEmail ?? "no-reply@tripdly.com";

  return `${senderName} from ${appName} <${fromEmail}>`;
}
