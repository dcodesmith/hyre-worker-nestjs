import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { AuthService } from "./auth.service";
import { ADMIN, FLEET_OWNER, MOBILE, STAFF, USER, WEB } from "./auth.types";
import { AuthEmailService } from "./auth-email.service";

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

  const mockDatabaseService: {
    user?: {
      findUnique: ReturnType<typeof vi.fn>;
      update?: ReturnType<typeof vi.fn>;
    };
  } = {};
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

  describe("validateRoleForClient", () => {
    beforeEach(async () => {
      await setupTestModule({
        SESSION_SECRET: "test-secret-at-least-32-characters-long",
        AUTH_BASE_URL: "https://api.example.com",
        TRUSTED_ORIGINS: ["https://example.com"],
        NODE_ENV: "production",
      });
    });

    describe("mobile client", () => {
      it("should allow user role for mobile client", () => {
        const result = service.validateRoleForClient({
          role: USER,
          origin: null,
          clientType: MOBILE,
        });
        expect(result).toBe(true);
      });

      it("should reject fleetOwner role for mobile client", () => {
        const result = service.validateRoleForClient({
          role: FLEET_OWNER,
          origin: null,
          clientType: MOBILE,
        });
        expect(result).toBe(false);
      });

      it("should reject admin role for mobile client", () => {
        const result = service.validateRoleForClient({
          role: ADMIN,
          origin: null,
          clientType: MOBILE,
        });
        expect(result).toBe(false);
      });

      it("should reject staff role for mobile client", () => {
        const result = service.validateRoleForClient({
          role: STAFF,
          origin: null,
          clientType: MOBILE,
        });
        expect(result).toBe(false);
      });
    });

    describe("web client without origin", () => {
      it("should reject any role when no origin and not mobile", () => {
        const result = service.validateRoleForClient({
          role: USER,
          origin: null,
          clientType: null,
        });
        expect(result).toBe(false);
      });

      it("should reject even with web client type but no origin", () => {
        const result = service.validateRoleForClient({
          role: USER,
          origin: null,
          clientType: WEB,
        });
        expect(result).toBe(false);
      });
    });

    describe("web client with origin (default public auth)", () => {
      it("should allow user role", () => {
        const result = service.validateRoleForClient({
          role: USER,
          origin: "https://example.com",
          clientType: WEB,
        });
        expect(result).toBe(true);
      });

      it("should reject fleetOwner role", () => {
        const result = service.validateRoleForClient({
          role: FLEET_OWNER,
          origin: "https://example.com",
          clientType: WEB,
        });
        expect(result).toBe(false);
      });

      it("should reject admin role", () => {
        const result = service.validateRoleForClient({
          role: ADMIN,
          origin: "https://example.com",
          clientType: WEB,
        });
        expect(result).toBe(false);
      });
    });

    describe("web client accessing /admin path", () => {
      it("should allow admin role", () => {
        const result = service.validateRoleForClient({
          role: ADMIN,
          origin: "https://example.com",
          clientType: WEB,
          referer: "https://example.com/admin/dashboard",
        });
        expect(result).toBe(true);
      });

      it("should allow staff role", () => {
        const result = service.validateRoleForClient({
          role: STAFF,
          origin: "https://example.com",
          clientType: WEB,
          referer: "https://example.com/admin/users",
        });
        expect(result).toBe(true);
      });

      it("should reject user role", () => {
        const result = service.validateRoleForClient({
          role: USER,
          origin: "https://example.com",
          clientType: WEB,
          referer: "https://example.com/admin/dashboard",
        });
        expect(result).toBe(false);
      });

      it("should reject fleetOwner role", () => {
        const result = service.validateRoleForClient({
          role: FLEET_OWNER,
          origin: "https://example.com",
          clientType: WEB,
          referer: "https://example.com/admin/dashboard",
        });
        expect(result).toBe(false);
      });
    });

    describe("web client accessing /fleet-owner path", () => {
      it("should allow fleetOwner role", () => {
        const result = service.validateRoleForClient({
          role: FLEET_OWNER,
          origin: "https://example.com",
          clientType: WEB,
          referer: "https://example.com/fleet-owner/vehicles",
        });
        expect(result).toBe(true);
      });

      it("should reject user role", () => {
        const result = service.validateRoleForClient({
          role: USER,
          origin: "https://example.com",
          clientType: WEB,
          referer: "https://example.com/fleet-owner/dashboard",
        });
        expect(result).toBe(false);
      });

      it("should reject admin role", () => {
        const result = service.validateRoleForClient({
          role: ADMIN,
          origin: "https://example.com",
          clientType: WEB,
          referer: "https://example.com/fleet-owner/dashboard",
        });
        expect(result).toBe(false);
      });
    });

    describe("origin fallback when no referer", () => {
      it("should use origin to detect /admin path when referer is not provided", () => {
        const result = service.validateRoleForClient({
          role: ADMIN,
          origin: "https://example.com/admin",
          clientType: WEB,
        });
        expect(result).toBe(true);
      });
    });
  });

  describe("validateExistingUserRole", () => {
    beforeEach(async () => {
      await setupTestModule({
        SESSION_SECRET: "test-secret-at-least-32-characters-long",
        AUTH_BASE_URL: "https://api.example.com",
        TRUSTED_ORIGINS: ["https://example.com"],
        NODE_ENV: "production",
      });
    });

    it("should return true for new user (not found)", async () => {
      mockDatabaseService.user = {
        findUnique: vi.fn().mockResolvedValue(null),
      };

      const result = await service.validateExistingUserRole("new@example.com", USER);
      expect(result).toBe(true);
    });

    it("should return true if existing user has the role", async () => {
      mockDatabaseService.user = {
        findUnique: vi.fn().mockResolvedValue({
          id: "user-1",
          email: "existing@example.com",
          roles: [{ name: USER }],
        }),
      };

      const result = await service.validateExistingUserRole("existing@example.com", USER);
      expect(result).toBe(true);
    });

    it("should return false if existing user does not have the role", async () => {
      mockDatabaseService.user = {
        findUnique: vi.fn().mockResolvedValue({
          id: "user-1",
          email: "existing@example.com",
          roles: [{ name: USER }],
        }),
      };

      const result = await service.validateExistingUserRole("existing@example.com", ADMIN);
      expect(result).toBe(false);
    });

    it("should return true if user has multiple roles including requested", async () => {
      mockDatabaseService.user = {
        findUnique: vi.fn().mockResolvedValue({
          id: "user-1",
          email: "admin@example.com",
          roles: [{ name: USER }, { name: ADMIN }],
        }),
      };

      const result = await service.validateExistingUserRole("admin@example.com", ADMIN);
      expect(result).toBe(true);
    });
  });

  describe("assignRoleOnVerify", () => {
    beforeEach(async () => {
      await setupTestModule({
        SESSION_SECRET: "test-secret-at-least-32-characters-long",
        AUTH_BASE_URL: "https://api.example.com",
        TRUSTED_ORIGINS: ["https://example.com"],
        NODE_ENV: "production",
      });

      mockDatabaseService.user = {
        findUnique: vi.fn(),
        update: vi.fn(),
      };
    });

    it("should grant user role if missing (grantable)", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [],
      });
      mockDatabaseService.user.update.mockResolvedValue({});

      await service.assignRoleOnVerify("user-1", USER);

      expect(mockDatabaseService.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { roles: { connect: { name: USER } } },
      });
    });

    it("should grant fleetOwner role if missing (grantable)", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [],
      });
      mockDatabaseService.user.update.mockResolvedValue({});

      await service.assignRoleOnVerify("user-1", FLEET_OWNER);

      expect(mockDatabaseService.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { roles: { connect: { name: FLEET_OWNER } } },
      });
    });

    it("should not grant role if user already has it", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [{ name: USER }],
      });

      await service.assignRoleOnVerify("user-1", USER);

      expect(mockDatabaseService.user.update).not.toHaveBeenCalled();
    });

    it("should throw for admin role if user does not have it (protected)", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [{ name: USER }],
      });

      await expect(service.assignRoleOnVerify("user-1", ADMIN)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should not throw for admin role if user already has it", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [{ name: ADMIN }],
      });

      await expect(service.assignRoleOnVerify("user-1", ADMIN)).resolves.not.toThrow();
      expect(mockDatabaseService.user.update).not.toHaveBeenCalled();
    });

    it("should throw for staff role if user does not have it (protected)", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [],
      });

      await expect(service.assignRoleOnVerify("user-1", STAFF)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe("ensureUserHasRole", () => {
    beforeEach(async () => {
      await setupTestModule({
        SESSION_SECRET: "test-secret-at-least-32-characters-long",
        AUTH_BASE_URL: "https://api.example.com",
        TRUSTED_ORIGINS: ["https://example.com"],
        NODE_ENV: "production",
      });

      mockDatabaseService.user = {
        findUnique: vi.fn(),
        update: vi.fn(),
      };
    });

    it("should do nothing if user not found", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue(null);

      await service.ensureUserHasRole("nonexistent", USER);

      expect(mockDatabaseService.user.update).not.toHaveBeenCalled();
    });

    it("should grant role if user does not have it", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [],
      });
      mockDatabaseService.user.update.mockResolvedValue({});

      await service.ensureUserHasRole("user-1", USER);

      expect(mockDatabaseService.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { roles: { connect: { name: USER } } },
      });
    });

    it("should not update if user already has role", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [{ name: USER }],
      });

      await service.ensureUserHasRole("user-1", USER);

      expect(mockDatabaseService.user.update).not.toHaveBeenCalled();
    });
  });

  describe("verifyUserHasRole", () => {
    beforeEach(async () => {
      await setupTestModule({
        SESSION_SECRET: "test-secret-at-least-32-characters-long",
        AUTH_BASE_URL: "https://api.example.com",
        TRUSTED_ORIGINS: ["https://example.com"],
        NODE_ENV: "production",
      });

      mockDatabaseService.user = {
        findUnique: vi.fn(),
      };
    });

    it("should not throw if user has the role", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [{ name: ADMIN }],
      });

      await expect(service.verifyUserHasRole("user-1", ADMIN)).resolves.not.toThrow();
    });

    it("should throw UnauthorizedException if user does not have the role", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [{ name: USER }],
      });

      await expect(service.verifyUserHasRole("user-1", ADMIN)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should throw UnauthorizedException if user not found", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue(null);

      await expect(service.verifyUserHasRole("nonexistent", ADMIN)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should throw with descriptive message", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [],
      });

      await expect(service.verifyUserHasRole("user-1", ADMIN)).rejects.toThrow(
        "User does not have required role: admin",
      );
    });
  });
});
