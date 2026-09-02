import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { maskEmail } from "../../shared/helper";
import { renderAuthOTPEmail } from "../../templates/emails";
import { EmailService } from "../email/email.service";

@Injectable()
export class AuthEmailService {
  constructor(
    private readonly emailService: EmailService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthEmailService.name);
  }

  async sendOTPEmail(email: string, otp: string): Promise<void> {
    const maskedEmail = maskEmail(email);

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
