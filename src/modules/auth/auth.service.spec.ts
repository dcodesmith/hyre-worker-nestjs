import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { AuthEmailService } from "./auth-email.service";
import { AuthService } from "./auth.service";

// Mock createAuth
vi.mock("./auth.config", () => ({
  createAuth: vi.fn().mockReturnValue({
    api: {
      getSession: vi.fn(),
    },
  }),
}));

type AuthConfig = {
  SESSION_SECRET?: string;
  AUTH_BASE_URL?: string;
  TRUSTED_ORIGINS?: string[];
  NODE_ENV?: string;
};

describe("AuthService", () => {
  let service: AuthService;

  const mockDatabaseService = {};
  const mockAuthEmailService = {
    sendOTPEmail: vi.fn(),
  };

  const setupTestModule = async (config: AuthConfig = {}) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DatabaseService, useValue: mockDatabaseService },
        { provide: AuthEmailService, useValue: mockAuthEmailService },
        {
          provide: ConfigService,
          useValue: { get: vi.fn((key: string) => config[key as keyof AuthConfig]) },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    service.onModuleInit();
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when auth config is complete", () => {
    beforeEach(async () => {
      await setupTestModule({
        SESSION_SECRET: "test-secret-at-least-32-characters-long",
        AUTH_BASE_URL: "https://api.example.com",
        TRUSTED_ORIGINS: ["https://example.com", "https://app.example.com"],
        NODE_ENV: "production",
      });
    });

    it("should be defined", () => {
      expect(service).toBeDefined();
    });

    it("should be initialized", () => {
      expect(service.isInitialized).toBe(true);
    });

    it("should return auth instance", () => {
      expect(service.auth).toBeDefined();
      expect(service.auth.api).toBeDefined();
    });
  });

  describe("when auth config is incomplete", () => {
    beforeEach(async () => {
      await setupTestModule();
    });

    it("should not be initialized", () => {
      expect(service.isInitialized).toBe(false);
    });

    it("should throw when accessing auth instance", () => {
      expect(() => service.auth).toThrow(
        "Auth service not initialized. Ensure SESSION_SECRET, AUTH_BASE_URL, and TRUSTED_ORIGINS are configured.",
      );
    });
  });

  describe("when only some config is provided", () => {
    beforeEach(async () => {
      await setupTestModule({
        SESSION_SECRET: "test-secret",
        TRUSTED_ORIGINS: ["https://example.com"],
      });
    });

    it("should not be initialized when AUTH_BASE_URL is missing", () => {
      expect(service.isInitialized).toBe(false);
    });
  });
});
