import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ModuleRef } from "@nestjs/core";
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
      inject: [ConfigService, ModuleRef],
      useFactory: async (configService: ConfigService<EnvConfig>, moduleRef: ModuleRef) => {
        const nodeEnv = configService.get("NODE_ENV", { infer: true });
        const emailProvider = configService.get("EMAIL_PROVIDER", { infer: true });
        const provider = emailProvider ?? (nodeEnv === "production" ? "resend" : "smtp");

        if (provider === "resend") {
          return moduleRef.create(ResendEmailTransport);
        }

        return moduleRef.create(SmtpEmailTransport);
      },
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
