import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EnvConfig } from "src/config/env.config";
import { EMAIL_TRANSPORT_TOKEN } from "./email.const";
import { EmailService } from "./email.service";
import { ResendEmailTransport } from "./resend-email.transport";
import { SmtpEmailTransport } from "./smtp-email.transport";

@Module({
  providers: [
    EmailService,
    {
      provide: EMAIL_TRANSPORT_TOKEN,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig>) => {
        const nodeEnv = configService.get("NODE_ENV", { infer: true });
        const emailProvider = configService.get("EMAIL_PROVIDER", { infer: true });
        const provider = emailProvider ?? (nodeEnv === "production" ? "resend" : "smtp");

        if (provider === "resend") {
          return new ResendEmailTransport(configService);
        }

        return new SmtpEmailTransport(configService);
      },
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
