import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import type { EnvConfig } from "../../config/env.config";
import { maskEmail } from "../../shared/helper";
import { renderAuthOTPEmail } from "../../templates/emails";
import { EmailService } from "../email/email.service";

@Injectable()
export class AuthEmailService {
  constructor(
    private readonly emailService: EmailService,
    private readonly configService: ConfigService<EnvConfig>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthEmailService.name);
  }

  async sendOTPEmail(email: string, otp: string): Promise<void> {
    const nodeEnv = this.configService.get("NODE_ENV", { infer: true });
    const isDevelopment = nodeEnv === "development";
    const maskedEmail = isDevelopment ? email : maskEmail(email);

    if (isDevelopment) {
      this.logger.info({ email: maskedEmail, otp }, "Dev OTP generated");
    }

    this.logger.info({ email: maskedEmail }, "Sending OTP email");

    const html = await renderAuthOTPEmail({ otp });

    await this.emailService.sendEmail({
      to: email,
      subject: "Your Verification Code",
      html,
    });

    this.logger.info({ email: maskedEmail }, "OTP email sent successfully");
  }
}
