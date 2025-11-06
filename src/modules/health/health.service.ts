import { Injectable } from "@nestjs/common";
import { HealthCheckResult, HealthCheckService, PrismaHealthIndicator } from "@nestjs/terminus";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class HealthService {
  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly databaseService: DatabaseService,
  ) {}

  async checkHealth(): Promise<HealthCheckResult> {
    return this.healthCheckService.check([
      () => this.prismaHealth.pingCheck("database", this.databaseService),
    ]);
  }
}

