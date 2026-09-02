import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import { Resend } from "resend";
import { EnvConfig } from "src/config/env.config";
import { getErrorMessage, toLogError } from "../../common/logging/error-logging.helper";
import { EmailDeliveryFailedException, EmailProviderResponseException } from "./email.error";
import { getFromAddress } from "./email.helper";
import { EmailPayload, EmailSendResult, EmailTransport } from "./email.interface";

@Injectable()
export class ResendEmailTransport implements EmailTransport {
  private readonly provider = "resend";
  private readonly resend: Resend;
  private readonly from: string;

  constructor(
    private readonly configService: ConfigService<EnvConfig>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ResendEmailTransport.name);
    const apiKey = this.configService.get("RESEND_API_KEY", { infer: true });
    this.resend = new Resend(apiKey);
    this.from = getFromAddress(this.configService);
    this.logger.info("Resend email transport initialized");
  }

  async sendEmail({ to, subject, html }: EmailPayload): Promise<EmailSendResult> {
    const recipientDomain = to.includes("@") ? to.split("@")[1] : "unknown";
    let result: EmailSendResult;
    try {
      result = await this.resend.emails.send({
        from: this.from,
        to,
        subject,
        html,
      });
    } catch (error) {
      this.logger.error(
        {
          provider: this.provider,
          recipientDomain,
          err: toLogError(error),
        },
        "Failed to send email via Resend",
      );
      throw new EmailDeliveryFailedException("Resend request failed", {
        provider: this.provider,
        recipientDomain,
        cause: getErrorMessage(error),
      });
    }

    if (result.error) {
      const errorCode =
        typeof result.error === "object" && result.error && "code" in result.error
          ? result.error.code
          : result.error;
      const normalizedErrorCode =
        typeof errorCode === "string" || typeof errorCode === "number"
          ? errorCode.toString()
          : "unknown";
      this.logger.error(
        {
          provider: this.provider,
          errorCode: normalizedErrorCode,
        },
        "Email API returned error",
      );

      throw new EmailProviderResponseException(this.provider, {
        providerErrorCode: normalizedErrorCode,
      });
    }

    this.logger.info(
      {
        provider: this.provider,
        messageId: result.data?.id ?? "unknown",
      },
      "Email sent successfully",
    );

    return result;
  }
}
