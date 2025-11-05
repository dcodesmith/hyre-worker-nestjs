import { Controller, Get } from "@nestjs/common";
import { HealthCheck, type HealthCheckResult } from "@nestjs/terminus";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @HealthCheck()
  async checkHealth(): Promise<HealthCheckResult> {
    return await this.healthService.checkHealth();
  }
}
