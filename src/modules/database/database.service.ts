import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly isDevelopment: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    const databaseUrl = configService.get<string>("DATABASE_URL");
    const isDevelopment = configService.get<string>("NODE_ENV") === "development";
    const adapter = new PrismaPg({ connectionString: databaseUrl });

    super({
      adapter,
      log: isDevelopment
        ? [
            { level: "query", emit: "event" },
            { level: "info", emit: "stdout" },
            { level: "warn", emit: "stdout" },
            { level: "error", emit: "stdout" },
          ]
        : [
            { level: "warn", emit: "stdout" },
            { level: "error", emit: "stdout" },
          ],
    });

    this.isDevelopment = isDevelopment;
    this.logger.setContext(DatabaseService.name);
    this.setupSlowQueryLogging();
  }

  private setupSlowQueryLogging(): void {
    if (!this.isDevelopment) return;

    const slowQueryThresholdMs = this.configService.get<number>("SLOW_QUERY_THRESHOLD_MS", 1000);

    this.$on("query", (event: Prisma.QueryEvent) => {
      if (event.duration > slowQueryThresholdMs) {
        this.logger.warn(
          {
            durationMs: event.duration,
            query: event.query,
            paramsLength: event.params?.length ?? 0,
          },
          "Prisma slow query detected",
        );
      }
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.info("Database connected successfully");
  }

  async onModuleDestroy() {
    this.logger.info("Disconnecting database client...");
    await this.$disconnect();
  }
}
