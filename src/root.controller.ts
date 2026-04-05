import { Controller, Get } from "@nestjs/common";

type RootInfoResponse = {
  service: string;
  status: "ok";
  environment: string;
  timestamp: string;
};

@Controller()
export class RootController {
  @Get()
  getRootInfo(): RootInfoResponse {
    return {
      service: "hyre-worker-nestjs",
      status: "ok",
      environment: process.env.NODE_ENV ?? "unknown",
      timestamp: new Date().toISOString(),
    };
  }
}
