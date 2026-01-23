import { Injectable, Logger } from "@nestjs/common";
import { renderAuthOTPEmail } from "../../templates/emails";
import { EmailService } from "../notification/email.service";

@Injectable()
export class AuthEmailService {
  private readonly logger = new Logger(AuthEmailService.name);

  constructor(private readonly emailService: EmailService) {}

  async sendOTPEmail(email: string, otp: string): Promise<void> {
    this.logger.log(`Sending OTP email to ${email}`);

    const html = await renderAuthOTPEmail({ otp });

    await this.emailService.sendEmail({
      to: email,
      subject: "Your Verification Code",
      html,
    });

    this.logger.log(`OTP email sent successfully to ${email}`);
  }
}
