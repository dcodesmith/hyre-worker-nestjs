import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { EnvConfig } from "src/config/env.config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { ADMIN, FLEET_OWNER, MOBILE, STAFF, USER, WEB } from "./auth.const";
import {
  AuthErrorCode,
  type AuthErrorCodeValue,
  AuthInternalServerException,
  AuthNotFoundException,
  AuthUnauthorizedException,
} from "./auth.error";
import { AuthService } from "./auth.service";
import { AuthEmailService } from "./auth-email.service";

// Mock createAuth
vi.mock("./auth.config", () => ({
  createAuth: vi.fn().mockReturnValue({
    api: {
      getSession: vi.fn(),
    },
  }),
}));

describe("AuthService", () => {
  let service: AuthService;

  const mockConfigService = {
    get: vi.fn(),
  };

  const mockDatabaseService: {
    $transaction?: ReturnType<typeof vi.fn>;
    $executeRaw?: ReturnType<typeof vi.fn>;
    user?: {
      findUnique: ReturnType<typeof vi.fn>;
      update?: ReturnType<typeof vi.fn>;
    };
    referralAttribution?: {
      create: ReturnType<typeof vi.fn>;
    };
  } = {};

  const mockAuthEmailService = {
    sendOTPEmail: vi.fn(),
  };

  const baseConfig = {
    SESSION_SECRET: "test-secret-at-least-32-characters-long",
    AUTH_BASE_URL: "https://api.example.com",
    TRUSTED_ORIGINS: ["https://example.com"],
    NODE_ENV: "production",
  } satisfies Record<
    keyof Pick<EnvConfig, "SESSION_SECRET" | "AUTH_BASE_URL" | "TRUSTED_ORIGINS" | "NODE_ENV">,
    string | string[]
  >;

  const setupTestModule = async (overrides: Partial<typeof baseConfig> = {}) => {
    const config = { ...baseConfig, ...overrides };

    mockConfigService.get.mockImplementation((key: keyof EnvConfig) => {
      if (key in config) {
        return config[key as keyof typeof config];
      }
      return undefined;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DatabaseService, useValue: mockDatabaseService },
        { provide: AuthEmailService, useValue: mockAuthEmailService },
        {
          provide: ConfigService<EnvConfig>,
          useValue: mockConfigService,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<AuthService>(AuthService);
    service.onModuleInit();
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await setupTestModule();
  });

  const expectProblemDetail = async (
    promise: Promise<unknown>,
    {
      errorClass,
      errorCode,
      title,
      detail,
    }: {
      errorClass: abstract new (...args: unknown[]) => Error;
      errorCode: AuthErrorCodeValue;
      title: string;
      detail: string;
    },
  ) => {
    await expect(promise).rejects.toBeInstanceOf(errorClass);
    await expect(promise).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode,
        title,
        detail,
      }),
    });
  };

  describe("when auth config is complete", () => {
    beforeEach(async () => {
      await setupTestModule({
        TRUSTED_ORIGINS: ["https://example.com", "https://app.example.com"],
      });
    });
    it("should be initialized", () => {
      expect(service.isInitialized).toBe(true);
    });

    it("should return auth instance", () => {
      expect(service.auth).toBeDefined();
      expect(service.auth.api).toBeDefined();
    });
  });

  describe("validateRoleForClient", () => {
    beforeEach(async () => {
      await setupTestModule();
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

    describe("path matching security", () => {
      it.each([
        {
          name: "reject admin role for paths that contain but don't start with /admin",
          role: ADMIN,
          referer: "https://example.com/not-admin/dashboard",
          expected: false,
        },
        {
          name: "reject fleetOwner role for paths that contain but don't start with /fleet-owner",
          role: FLEET_OWNER,
          referer: "https://example.com/fake-fleet-owner/vehicles",
          expected: false,
        },
        {
          name: "handle malformed referer URLs by falling back to the origin user role",
          role: USER,
          referer: "not-a-valid-url",
          expected: true,
        },
        {
          name: "handle path-only referer strings",
          role: ADMIN,
          referer: "/admin/dashboard",
          expected: true,
        },
        {
          name: "strip query parameters from path-only referer strings",
          role: ADMIN,
          referer: "/admin?query=value",
          expected: true,
        },
        {
          name: "strip fragments from path-only referer strings",
          role: ADMIN,
          referer: "/admin#section",
          expected: true,
        },
        {
          name: "strip both query and fragment from path-only referer strings",
          role: ADMIN,
          referer: "/admin/dashboard?tab=users#section",
          expected: true,
        },
        {
          name: "parse fleet-owner path with query parameters",
          role: FLEET_OWNER,
          referer: "/fleet-owner?vehicle=123",
          expected: true,
        },
        {
          name: "parse fleet-owner path with fragment",
          role: FLEET_OWNER,
          referer: "/fleet-owner#vehicles",
          expected: true,
        },
        {
          name: "normalize path traversal in path-only referer for fleet-owner",
          role: FLEET_OWNER,
          referer: "/fleet-owner/../",
          expected: false,
        },
        {
          name: "normalize path traversal in path-only referer for admin",
          role: ADMIN,
          referer: "/admin/../user",
          expected: false,
        },
        {
          name: "allow user role when path traversal resolves to root",
          role: USER,
          referer: "/fleet-owner/../",
          expected: true,
        },
        {
          name: "reject nested path traversal that leaves the admin directory",
          role: ADMIN,
          referer: "/admin/deep/../../../user",
          expected: false,
        },
        {
          name: "allow path traversal that stays within the admin directory",
          role: ADMIN,
          referer: "/admin/sub/../dashboard",
          expected: true,
        },
        {
          name: "reject admin role for /administrator without a segment boundary",
          role: ADMIN,
          referer: "https://example.com/administrator",
          expected: false,
        },
        {
          name: "reject admin role for /admin-panel without a segment boundary",
          role: ADMIN,
          referer: "https://example.com/admin-panel",
          expected: false,
        },
        {
          name: "allow admin role for exact /admin path",
          role: ADMIN,
          referer: "https://example.com/admin",
          expected: true,
        },
        {
          name: "reject fleetOwner role for /fleet-owners without a segment boundary",
          role: FLEET_OWNER,
          referer: "https://example.com/fleet-owners",
          expected: false,
        },
        {
          name: "allow fleetOwner role for exact /fleet-owner path",
          role: FLEET_OWNER,
          referer: "https://example.com/fleet-owner",
          expected: true,
        },
      ])("should $name", ({ role, referer, expected }) => {
        const result = service.validateRoleForClient({
          role,
          origin: "https://example.com",
          clientType: WEB,
          referer,
        });
        expect(result).toBe(expected);
      });
    });

    describe("untrusted origin validation", () => {
      it.each([
        {
          name: "untrusted origins",
          role: USER,
          origin: "https://evil.com",
        },
        {
          name: "spoofed origin attempting to get fleetOwner role",
          role: FLEET_OWNER,
          origin: "https://evil.com",
          referer: "https://evil.com/fleet-owner/dashboard",
        },
        {
          name: "spoofed origin attempting to get admin role",
          role: ADMIN,
          origin: "https://attacker.com",
          referer: "https://attacker.com/admin/dashboard",
        },
        {
          name: "malformed origin URLs",
          role: USER,
          origin: "not-a-valid-url",
        },
        {
          name: "origin with a different port than trusted",
          role: USER,
          origin: "https://example.com:8080",
        },
        {
          name: "origin with a different protocol than trusted",
          role: USER,
          origin: "http://example.com",
        },
        {
          name: "subdomain when only the root domain is trusted",
          role: USER,
          origin: "https://sub.example.com",
        },
      ])("should reject $name", ({ role, origin, referer }) => {
        const result = service.validateRoleForClient({
          role,
          origin,
          clientType: WEB,
          referer,
        });
        expect(result).toBe(false);
      });
    });

    describe("trusted origin with multiple entries", () => {
      beforeEach(async () => {
        await setupTestModule({
          TRUSTED_ORIGINS: [
            "https://example.com",
            "https://app.example.com",
            "https://admin.example.com",
          ],
        });
      });

      it("should allow any trusted origin", () => {
        const result1 = service.validateRoleForClient({
          role: USER,
          origin: "https://example.com",
          clientType: WEB,
        });
        expect(result1).toBe(true);

        const result2 = service.validateRoleForClient({
          role: USER,
          origin: "https://app.example.com",
          clientType: WEB,
        });
        expect(result2).toBe(true);
      });

      it("should still reject untrusted origins when multiple are configured", () => {
        const result = service.validateRoleForClient({
          role: USER,
          origin: "https://untrusted.example.com",
          clientType: WEB,
        });
        expect(result).toBe(false);
      });
    });
  });

  describe("validateExistingUserRole", () => {
    beforeEach(async () => {
      await setupTestModule();
    });

    describe("new user (not found in database)", () => {
      beforeEach(() => {
        mockDatabaseService.user = {
          findUnique: vi.fn().mockResolvedValue(null),
        };
      });

      it("should return true for user role (grantable)", async () => {
        const result = await service.validateExistingUserRole("new@example.com", USER);
        expect(result).toBe(true);
      });

      it("should return true for fleetOwner role (grantable)", async () => {
        const result = await service.validateExistingUserRole("new@example.com", FLEET_OWNER);
        expect(result).toBe(true);
      });

      it("should return false for admin role (protected)", async () => {
        const result = await service.validateExistingUserRole("new@example.com", ADMIN);
        expect(result).toBe(false);
      });

      it("should return false for staff role (protected)", async () => {
        const result = await service.validateExistingUserRole("new@example.com", STAFF);
        expect(result).toBe(false);
      });
    });

    describe("existing user", () => {
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

      it("should return true for admin with existing admin role (protected but already has it)", async () => {
        mockDatabaseService.user = {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-1",
            email: "admin@example.com",
            roles: [{ name: ADMIN }],
          }),
        };

        const result = await service.validateExistingUserRole("admin@example.com", ADMIN);
        expect(result).toBe(true);
      });

      it("should return true for staff with existing staff role (protected but already has it)", async () => {
        mockDatabaseService.user = {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-1",
            email: "staff@example.com",
            roles: [{ name: STAFF }],
          }),
        };

        const result = await service.validateExistingUserRole("staff@example.com", STAFF);
        expect(result).toBe(true);
      });
    });
  });

  describe("claimGuestBookingsForUser", () => {
    it("claims matching guest bookings only after email verification", async () => {
      mockDatabaseService.user = {
        findUnique: vi.fn().mockResolvedValue({
          email: "Guest@Example.com",
          emailVerified: true,
        }),
      };
      mockDatabaseService.$executeRaw = vi.fn().mockResolvedValue(2);

      await service.claimGuestBookingsForUser("user-1");

      expect(mockDatabaseService.$executeRaw).toHaveBeenCalledOnce();
    });

    it("does not claim bookings for an unverified account", async () => {
      mockDatabaseService.user = {
        findUnique: vi.fn().mockResolvedValue({
          email: "guest@example.com",
          emailVerified: false,
        }),
      };
      mockDatabaseService.$executeRaw = vi.fn();

      await service.claimGuestBookingsForUser("user-1");

      expect(mockDatabaseService.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe("assignRoleToNewUser", () => {
    beforeEach(async () => {
      await setupTestModule();

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

      await service.assignRoleToNewUser("user-1", USER);

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

      await service.assignRoleToNewUser("user-1", FLEET_OWNER);

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

      await service.assignRoleToNewUser("user-1", USER);

      expect(mockDatabaseService.user.update).not.toHaveBeenCalled();
    });

    it("should throw for admin role (protected roles cannot be assigned to new users)", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [],
      });

      await expectProblemDetail(service.assignRoleToNewUser("user-1", ADMIN), {
        errorClass: AuthUnauthorizedException,
        errorCode: AuthErrorCode.AUTH_PROTECTED_ROLE_ASSIGNMENT_DENIED,
        title: "Protected Role Assignment Denied",
        detail: 'Protected role "admin" cannot be assigned to new users',
      });
    });

    it("should throw for staff role (protected roles cannot be assigned to new users)", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [],
      });

      await expectProblemDetail(service.assignRoleToNewUser("user-1", STAFF), {
        errorClass: AuthUnauthorizedException,
        errorCode: AuthErrorCode.AUTH_PROTECTED_ROLE_ASSIGNMENT_DENIED,
        title: "Protected Role Assignment Denied",
        detail: 'Protected role "staff" cannot be assigned to new users',
      });
    });
  });

  describe("referral signup attribution", () => {
    beforeEach(async () => {
      await setupTestModule();

      mockDatabaseService.user = {
        findUnique: vi.fn(),
        update: vi.fn(),
      };
      mockDatabaseService.referralAttribution = {
        create: vi.fn(),
      };
      mockDatabaseService.$transaction = vi.fn(async (callback) =>
        callback({
          user: mockDatabaseService.user,
          referralAttribution: mockDatabaseService.referralAttribution,
        }),
      );
    });

    it("validates referral code and normalizes code casing", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "referrer-1",
        email: "referrer@example.com",
        referralCode: "FLOWREF1",
      });

      const result = await service.validateReferralCodeForSignup(
        " flowref1 ",
        "new-user@example.com",
      );

      expect(mockDatabaseService.user.findUnique).toHaveBeenCalledWith({
        where: { referralCode: "FLOWREF1" },
        select: { id: true, email: true, referralCode: true },
      });
      expect(result).toEqual({
        referrerUserId: "referrer-1",
        referralCode: "FLOWREF1",
      });
    });

    it("rejects invalid and self-referral codes", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.validateReferralCodeForSignup("MISSING1", "new@example.com"),
      ).resolves.toBe(null);

      mockDatabaseService.user.findUnique.mockResolvedValueOnce({
        id: "referrer-1",
        email: "same@example.com",
        referralCode: "SELFREF1",
      });
      await expect(
        service.validateReferralCodeForSignup("SELFREF1", "same@example.com"),
      ).resolves.toBe(null);
    });

    it("assigns a new referral code to a newly created user", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({ referralCode: null });
      mockDatabaseService.user.update.mockResolvedValue({});

      const referralCode = await service.assignReferralCodeToNewUser("user-1");

      expect(referralCode).toMatch(/^[A-Z2-9]{8}$/);
      expect(mockDatabaseService.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { referralCode },
      });
    });

    it("keeps an existing referral code unchanged", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({ referralCode: "EXIST123" });

      const referralCode = await service.assignReferralCodeToNewUser("user-1");

      expect(referralCode).toBe("EXIST123");
      expect(mockDatabaseService.user.update).not.toHaveBeenCalled();
    });

    it("throws an auth exception when referral code generation exhausts retries", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({ referralCode: null });
      mockDatabaseService.user.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        }),
      );

      await expectProblemDetail(service.assignReferralCodeToNewUser("user-1"), {
        errorClass: AuthInternalServerException,
        errorCode: AuthErrorCode.AUTH_REFERRAL_CODE_GENERATION_FAILED,
        title: "Referral Code Generation Failed",
        detail: "Failed to generate a unique referral code. Please try again.",
      });
      expect(mockDatabaseService.user.update).toHaveBeenCalledTimes(5);
    });

    it("assigns referral attribution to a newly created user", async () => {
      await service.assignReferralToNewUser("user-1", {
        referrerUserId: "referrer-1",
        referralCode: "FLOWREF1",
      });

      expect(mockDatabaseService.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: {
          referredByUserId: "referrer-1",
          referralAttributionSource: "LINK",
          referralSignupAt: expect.any(Date),
        },
      });
      expect(mockDatabaseService.referralAttribution.create).toHaveBeenCalledWith({
        data: {
          refereeUserId: "user-1",
          referrerUserId: "referrer-1",
          referralCode: "FLOWREF1",
          source: "LINK",
        },
      });
    });
  });

  describe("ensureUserHasRole", () => {
    beforeEach(async () => {
      await setupTestModule();

      mockDatabaseService.user = {
        findUnique: vi.fn(),
        update: vi.fn(),
      };
    });

    it("should throw error if user not found", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue(null);

      await expectProblemDetail(service.ensureUserHasRole("nonexistent", USER), {
        errorClass: AuthNotFoundException,
        errorCode: AuthErrorCode.AUTH_USER_NOT_FOUND_FOR_ROLE_ASSIGNMENT,
        title: "User Not Found For Role Assignment",
        detail: "User not found for role assignment",
      });

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
      await setupTestModule();

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

    it("should throw AuthUnauthorizedException if user does not have the role", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [{ name: USER }],
      });

      await expectProblemDetail(service.verifyUserHasRole("user-1", ADMIN), {
        errorClass: AuthUnauthorizedException,
        errorCode: AuthErrorCode.AUTH_ROLE_REQUIREMENT_FAILED,
        title: "Role Requirement Failed",
        detail: "User does not have required role: admin",
      });
    });

    it("should throw AuthUnauthorizedException if user not found", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue(null);

      await expectProblemDetail(service.verifyUserHasRole("nonexistent", ADMIN), {
        errorClass: AuthUnauthorizedException,
        errorCode: AuthErrorCode.AUTH_ROLE_REQUIREMENT_FAILED,
        title: "Role Requirement Failed",
        detail: "User does not have required role: admin",
      });
    });

    it("should throw with descriptive message", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [],
      });

      await expectProblemDetail(service.verifyUserHasRole("user-1", ADMIN), {
        errorClass: AuthUnauthorizedException,
        errorCode: AuthErrorCode.AUTH_ROLE_REQUIREMENT_FAILED,
        title: "Role Requirement Failed",
        detail: "User does not have required role: admin",
      });
    });
  });

  describe("getUserRoles", () => {
    beforeEach(async () => {
      await setupTestModule();

      mockDatabaseService.user = {
        findUnique: vi.fn(),
      };
    });

    it("should return empty array if user not found", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue(null);

      const roles = await service.getUserRoles("nonexistent");

      expect(roles).toEqual([]);
    });

    it("should return user roles", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [{ name: USER }, { name: ADMIN }],
      });

      const roles = await service.getUserRoles("user-1");

      expect(roles).toEqual([USER, ADMIN]);
    });

    it("should return empty array if user has no roles", async () => {
      mockDatabaseService.user.findUnique.mockResolvedValue({
        id: "user-1",
        roles: [],
      });

      const roles = await service.getUserRoles("user-1");

      expect(roles).toEqual([]);
    });
  });
});
