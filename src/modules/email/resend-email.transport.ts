import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import { Resend } from "resend";
import { EnvConfig } from "src/config/env.config";
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
    let result: EmailSendResult;
    try {
      result = await this.resend.emails.send({
        from: this.from,
        to,
        subject,
        html,
      });
    } catch (error) {
      throw new EmailDeliveryFailedException("Resend request failed", {
        provider: this.provider,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (result.error) {
      const errorCode =
        typeof result.error === "object" && result.error && "code" in result.error
          ? result.error.code
          : result.error;
      this.logger.error(
        {
          provider: this.provider,
          errorCode: String(errorCode),
        },
        "Email API returned error",
      );

      throw new EmailProviderResponseException(this.provider, {
        providerError: result.error,
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
