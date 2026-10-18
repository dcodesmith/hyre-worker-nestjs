import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { toLogError } from "../../common/logging/error-logging.helper";
import {
  type ChauffeurDecisionEmailProps,
  renderChauffeurDecisionEmail,
} from "../../templates/emails";
import { EmailService } from "../email/email.service";

export type ChauffeurDecisionEmail = ChauffeurDecisionEmailProps & {
  email: string;
};

@Injectable()
export class ChauffeurDecisionEmailService {
  constructor(
    private readonly emailService: EmailService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ChauffeurDecisionEmailService.name);
  }

  async send(verificationId: string, input: ChauffeurDecisionEmail): Promise<void> {
    try {
      await this.emailService.sendEmail({
        to: input.email,
        subject:
          input.decision === "APPROVED"
            ? "You're approved to drive on Tripdly"
            : "Update on your Tripdly chauffeur application",
        html: await renderChauffeurDecisionEmail(input),
        idempotencyKey: `chauffeur-decision_${verificationId}_${input.decision.toLowerCase()}`,
      });
    } catch (error) {
      this.logger.warn(
        {
          verificationId,
          decision: input.decision,
          err: toLogError(error),
        },
        "Failed to send chauffeur decision email",
      );
    }
  }
}
