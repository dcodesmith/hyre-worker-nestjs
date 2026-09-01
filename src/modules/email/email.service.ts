import { Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { getErrorMessage, toLogError } from "../../common/logging/error-logging.helper";
import { maskEmail } from "../../shared/helper";
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
      if (error instanceof EmailException) {
        throw error;
      }

      this.logger.error(
        { recipient: maskEmail(to), err: toLogError(error) },
        "Failed to send email",
      );

      throw new EmailDeliveryFailedException(undefined, {
        cause: getErrorMessage(error),
      });
    }
  }
}
