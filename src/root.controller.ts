import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvConfig } from "./config/env.config";

type RootInfoResponse = {
  service: string;
  status: "ok";
  environment: string;
  deployment: {
    version: string;
    commit: string;
  };
  timestamp: string;
};

@Controller()
export class RootController {
  constructor(private readonly configService: ConfigService<EnvConfig>) {}

  @Get()
  getRootInfo(): RootInfoResponse {
    return {
      service: "hyre-worker-nestjs",
      status: "ok",
      environment: this.configService.get("APP_ENV", { infer: true }) ?? "unknown",
      deployment: {
        version: this.configService.get("DEPLOYMENT_VERSION", { infer: true }) ?? "unknown",
        commit: this.configService.get("DEPLOYMENT_COMMIT", { infer: true }) ?? "unknown",
      },
      timestamp: new Date().toISOString(),
    };
  }
}
