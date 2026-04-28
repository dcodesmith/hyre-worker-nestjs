import { Inject, Injectable, Logger } from "@nestjs/common";
import { EMAIL_TRANSPORT_TOKEN } from "./email.const";
import { EmailDeliveryFailedException, EmailException } from "./email.error";
import { EmailPayload, EmailSendResult, EmailTransport } from "./email.interface";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(@Inject(EMAIL_TRANSPORT_TOKEN) private readonly transport: EmailTransport) {}

  async sendEmail({ to, subject, html }: EmailPayload): Promise<EmailSendResult> {
    try {
      return await this.transport.sendEmail({ to, subject, html });
    } catch (error) {
      this.logger.error("Failed to send email", {
        to,
        subject,
        error: String(error),
      });

      if (error instanceof EmailException) {
        throw error;
      }

      throw new EmailDeliveryFailedException(undefined, {
        subject,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
