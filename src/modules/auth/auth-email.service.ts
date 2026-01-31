import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvConfig } from "../../config/env.config";
import { maskEmail } from "../../shared/helper";
import { renderAuthOTPEmail } from "../../templates/emails";
import { EmailService } from "../notification/email.service";

@Injectable()
export class AuthEmailService {
  private readonly logger = new Logger(AuthEmailService.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly configService: ConfigService<EnvConfig>,
  ) {}

  async sendOTPEmail(email: string, otp: string): Promise<void> {
    const nodeEnv = this.configService.get("NODE_ENV", { infer: true });
    const isDevelopment = nodeEnv === "development";
    const maskedEmail = isDevelopment ? email : maskEmail(email);

    if (isDevelopment) {
      this.logger.log(`Dev OTP for ${maskedEmail}: ${otp}`);
      return;
    }

    this.logger.log(`Sending OTP email to ${maskedEmail}`);

    const html = await renderAuthOTPEmail({ otp });

    await this.emailService.sendEmail({
      to: email,
      subject: "Your Verification Code",
      html,
    });

    this.logger.log(`OTP email sent successfully to ${maskedEmail}`);
  }
}
