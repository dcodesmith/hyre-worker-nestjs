import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import nodemailer, { Transporter } from "nodemailer";
import { EnvConfig } from "src/config/env.config";
import { EmailDeliveryFailedException } from "./email.error";
import { getFromAddress } from "./email.helper";
import { EmailPayload, EmailSendResult, EmailTransport } from "./email.interface";

@Injectable()
export class SmtpEmailTransport implements EmailTransport {
  private readonly logger = new Logger(SmtpEmailTransport.name);
  private readonly provider = "smtp";
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(private readonly configService: ConfigService<EnvConfig>) {
    const host = this.configService.get("SMTP_HOST", { infer: true }) ?? "127.0.0.1";
    const port = this.configService.get("SMTP_PORT", { infer: true }) ?? 1025;
    const secure = this.configService.get("SMTP_SECURE", { infer: true }) ?? false;
    const user = this.configService.get("SMTP_USER", { infer: true });
    const pass = this.configService.get("SMTP_PASS", { infer: true });

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
    });

    this.from = getFromAddress(this.configService);
    this.logger.log("SMTP email transport initialized", {
      host,
      port,
      secure,
    });
  }

  async sendEmail({ to, subject, html }: EmailPayload): Promise<EmailSendResult> {
    const recipientDomain = to.includes("@") ? to.split("@")[1] : "unknown";

    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to,
        subject,
        html,
      });

      this.logger.log("Email sent via SMTP", {
        provider: this.provider,
        status: "sent",
        messageId: info.messageId,
      });

      return {
        data: { id: info.messageId },
      };
    } catch (error) {
      this.logger.error("Failed to send email via SMTP", {
        provider: this.provider,
        recipientDomain,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new EmailDeliveryFailedException("SMTP request failed", {
        provider: this.provider,
        recipientDomain,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
