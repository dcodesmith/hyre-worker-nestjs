import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, PrismaClient } from "@prisma/client";

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly isDevelopment: boolean;

  constructor(private readonly configService: ConfigService) {
    const databaseUrl = configService.get<string>("DATABASE_URL");
    const isDevelopment = configService.get<string>("NODE_ENV") === "development";

    super({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
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
    this.setupSlowQueryLogging();
  }

  private setupSlowQueryLogging(): void {
    if (!this.isDevelopment) return;

    const slowQueryThresholdMs = this.configService.get<number>("SLOW_QUERY_THRESHOLD_MS", 1000);

    this.$on("query", (event: Prisma.QueryEvent) => {
      if (event.duration > slowQueryThresholdMs) {
        this.logger.warn(`[Prisma] Slow Query (${event.duration}ms): ${event.query}`);
      }
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log("Database connected successfully");
  }

  async onModuleDestroy() {
    this.logger.log("Disconnecting database client...");
    await this.$disconnect();
  }
}
