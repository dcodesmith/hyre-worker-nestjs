import { Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { EMAIL_TRANSPORT_TOKEN } from "./email.const";
import { EmailDeliveryFailedException, EmailException } from "./email.error";
import { EmailPayload, EmailSendResult, EmailTransport } from "./email.interface";

@Injectable()
export class EmailService {
  constructor(
    @Inject(EMAIL_TRANSPORT_TOKEN) private readonly transport: EmailTransport,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EmailService.name);
  }

  async sendEmail({ to, subject, html }: EmailPayload): Promise<EmailSendResult> {
    try {
      return await this.transport.sendEmail({ to, subject, html });
    } catch (error) {
      this.logger.error({ to, subject, error: String(error) }, "Failed to send email");

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
