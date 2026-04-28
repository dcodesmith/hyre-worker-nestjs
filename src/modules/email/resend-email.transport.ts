import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resend } from "resend";
import { EnvConfig } from "src/config/env.config";
import { getFromAddress } from "./email.helper";
import { EmailPayload, EmailSendResult, EmailTransport } from "./email.interface";

@Injectable()
export class ResendEmailTransport implements EmailTransport {
  private readonly logger = new Logger(ResendEmailTransport.name);
  private readonly resend: Resend;
  private readonly from: string;

  constructor(private readonly configService: ConfigService<EnvConfig>) {
    const apiKey = this.configService.get("RESEND_API_KEY", { infer: true });

    if (!apiKey) {
      throw new Error("RESEND_API_KEY is required when EMAIL_PROVIDER=resend");
    }

    this.resend = new Resend(apiKey);
    this.from = getFromAddress(this.configService);
    this.logger.log("Resend email transport initialized");
  }

  async sendEmail({ to, subject, html }: EmailPayload): Promise<EmailSendResult> {
    const result = await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      html,
    });

    if (result.error) {
      this.logger.error("Email API returned error", {
        to,
        subject,
        error: result.error,
      });
      throw new Error(`Resend API error: ${JSON.stringify(result.error)}`);
    }

    this.logger.log("Email sent successfully", {
      to,
      subject,
      messageId: result.data?.id,
    });

    return result;
  }
}
