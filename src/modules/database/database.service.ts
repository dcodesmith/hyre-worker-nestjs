import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, PrismaClient } from "@prisma/client";

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(configService: ConfigService) {
    // Environment variables are validated at startup, so we can safely use them
    const databaseUrl = configService.get<string>("DATABASE_URL");

    super({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
      log:
        process.env.NODE_ENV === "development"
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

    if (process.env.NODE_ENV === "development") {
      this.$on("query", (queryEvent: Prisma.QueryEvent) => {
        if (queryEvent.duration > 1000) {
          this.logger.warn(
            `[Prisma] Slow Query (${queryEvent.duration}ms): ${queryEvent.query} -- Params: ${queryEvent.params}`,
          );
        }
      });
    }
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
