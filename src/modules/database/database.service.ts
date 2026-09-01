import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";

/** Prisma throws P2025 when an update's where clause matches no record. */
export function isRecordNotFoundError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

/**
 * Take a row-level lock on a car inside a transaction (`SELECT ... FOR UPDATE`)
 * so that concurrent approval-status transitions (approve / reject / re-upload)
 * serialize per car. Without this, one transaction can read asset state, then a
 * concurrent reject can commit, and the first transaction's write overwrites it —
 * leaving a car APPROVED with a rejected asset. Returns whether the car exists.
 */
export async function lockCarRow(tx: Prisma.TransactionClient, carId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM "Car" WHERE id = ${carId} FOR UPDATE`,
  );
  return rows.length > 0;
}

/** Take a row-level lock on a booking after its car has been locked. */
export async function lockBookingRow(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM "Booking" WHERE id = ${bookingId} FOR UPDATE`,
  );
  return rows.length > 0;
}

/** Serialize extension checkout creation for a booking leg. */
export async function lockBookingLegRow(
  tx: Prisma.TransactionClient,
  bookingLegId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM "BookingLeg" WHERE id = ${bookingLegId} FOR UPDATE`,
  );
  return rows.length > 0;
}

/** Serialize payment confirmation and expiry for an extension. */
export async function lockExtensionRow(
  tx: Prisma.TransactionClient,
  extensionId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM "Extension" WHERE id = ${extensionId} FOR UPDATE`,
  );
  return rows.length > 0;
}

function resolvePrismaLog(isTest: boolean, isDevelopment: boolean): Prisma.LogDefinition[] {
  if (isTest) {
    return [];
  }
  if (isDevelopment) {
    return [
      { level: "query", emit: "event" },
      { level: "info", emit: "stdout" },
      { level: "warn", emit: "stdout" },
      { level: "error", emit: "stdout" },
    ];
  }
  return [
    { level: "warn", emit: "stdout" },
    { level: "error", emit: "stdout" },
  ];
}

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly isDevelopment: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    const databaseUrl = configService.get<string>("DATABASE_URL");
    const nodeEnv = configService.get<string>("NODE_ENV");
    const isDevelopment = nodeEnv === "development";
    const isTest = nodeEnv === "test";
    const adapter = new PrismaPg({ connectionString: databaseUrl });

    super({
      adapter,
      // Expected constraint failures are asserted in e2e tests; Prisma's stdout
      // error logger would otherwise spam the suite before those catches run.
      log: resolvePrismaLog(isTest, isDevelopment),
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
