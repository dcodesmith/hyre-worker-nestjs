import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import OpenAI from "openai";
import type { EnvConfig } from "../../config/env.config";
import { OPENAI_SDK_CLIENT } from "./openai-sdk.tokens";

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: OPENAI_SDK_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig>) => {
        const apiKey = configService.get("OPENAI_API_KEY", { infer: true });
        return new OpenAI({ apiKey });
      },
    },
  ],
  exports: [OPENAI_SDK_CLIENT],
})
export class OpenAiSdkModule {}
