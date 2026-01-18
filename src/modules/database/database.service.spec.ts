import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "./database.service";

type PrismaLogConfig = Array<{ level: string; emit: string }>;

interface MockPrismaOptions {
  datasources: { db: { url: string } };
  log?: PrismaLogConfig;
}

// Track the last created instance for assertions
let lastPrismaInstance: {
  options: MockPrismaOptions;
  $connect: ReturnType<typeof vi.fn>;
  $disconnect: ReturnType<typeof vi.fn>;
  $on: ReturnType<typeof vi.fn>;
};

vi.mock("@prisma/client", () => {
  return {
    Prisma: {},
    PrismaClient: class PrismaClient {
      public options: MockPrismaOptions;
      public $connect = vi.fn();
      public $disconnect = vi.fn();
      public $on = vi.fn();

      constructor(options: MockPrismaOptions) {
        this.options = options;
        lastPrismaInstance = {
          options,
          $connect: this.$connect,
          $disconnect: this.$disconnect,
          $on: this.$on,
        };
      }
    },
  };
});

describe("DatabaseService", () => {
  const databaseUrl = "postgres://user:pass@localhost:5432/db";

  let mockConfigGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockConfigGet = vi.fn((key: string, defaultValue?: unknown) => {
      const config: Record<string, unknown> = {
        DATABASE_URL: databaseUrl,
        NODE_ENV: "test",
        SLOW_QUERY_THRESHOLD_MS: 1000,
      };
      return config[key] ?? defaultValue;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function createService(
    configOverrides: Record<string, unknown> = {},
  ): Promise<DatabaseService> {
    const baseConfig: Record<string, unknown> = {
      DATABASE_URL: databaseUrl,
      NODE_ENV: "test",
      SLOW_QUERY_THRESHOLD_MS: 1000,
    };

    mockConfigGet = vi.fn((key: string, defaultValue?: unknown) => {
      return configOverrides[key] ?? baseConfig[key] ?? defaultValue;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseService,
        {
          provide: ConfigService,
          useValue: { get: mockConfigGet },
        },
      ],
    }).compile();

    return module.get<DatabaseService>(DatabaseService);
  }

  describe("initialization", () => {
    it("should be defined", async () => {
      const service = await createService();
      expect(service).toBeDefined();
    });

    it("should use DATABASE_URL from config service", async () => {
      await createService();
      expect(lastPrismaInstance.options.datasources.db.url).toBe(databaseUrl);
    });
  });

  describe("logging configuration", () => {
    it("should enable verbose logging in development", async () => {
      await createService({ NODE_ENV: "development" });

      expect(lastPrismaInstance.options.log).toEqual([
        { level: "query", emit: "event" },
        { level: "info", emit: "stdout" },
        { level: "warn", emit: "stdout" },
        { level: "error", emit: "stdout" },
      ]);
      expect(lastPrismaInstance.$on).toHaveBeenCalledWith("query", expect.any(Function));
    });

    it("should enable minimal logging in non-development environments", async () => {
      await createService({ NODE_ENV: "production" });

      expect(lastPrismaInstance.options.log).toEqual([
        { level: "warn", emit: "stdout" },
        { level: "error", emit: "stdout" },
      ]);
      expect(lastPrismaInstance.$on).not.toHaveBeenCalled();
    });
  });

  describe("lifecycle hooks", () => {
    it("should connect on module init", async () => {
      const service = await createService();

      await service.onModuleInit();

      expect(lastPrismaInstance.$connect).toHaveBeenCalledOnce();
    });

    it("should disconnect on module destroy", async () => {
      const service = await createService();

      await service.onModuleDestroy();

      expect(lastPrismaInstance.$disconnect).toHaveBeenCalledOnce();
    });
  });
});
