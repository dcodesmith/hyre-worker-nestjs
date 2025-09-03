import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resend } from "resend";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend;
  private readonly from: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>("RESEND_API_KEY");
    const appName = this.configService.get<string>("APP_NAME");
    const fromEmail = this.configService.get<string>("RESEND_FROM_EMAIL");

    this.resend = new Resend(apiKey);
    this.from = `Damola from ${appName} <${fromEmail}>`;
    this.logger.log("Email service initialized successfully");
  }

  async sendEmail({
    to,
    subject,
    html,
  }: {
    to: string;
    subject: string;
    html: string;
  }): ReturnType<typeof this.resend.emails.send> {
    try {
      const result = await this.resend.emails.send({
        from: this.from,
        to,
        subject,
        html,
      });

      this.logger.log("Email sent successfully", {
        to,
        subject,
        messageId: result.data?.id,
      });

      return result;
    } catch (error) {
      this.logger.error("Failed to send email", {
        to,
        subject,
        error: String(error),
      });
      throw error;
    }
  }
}
