import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleName } from "../auth.types";
import { RoleGuard } from "./role.guard";
import { AUTH_SESSION_KEY, type AuthSession } from "./session.guard";

describe("RoleGuard", () => {
  let guard: RoleGuard;
  let reflector: Reflector;

  const createMockSession = (roles: RoleName[]): AuthSession => ({
    user: {
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      roles,
    },
    session: {
      id: "session-123",
      userId: "user-123",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      token: "token-123",
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: "127.0.0.1",
      userAgent: "test-agent",
    },
  });

  const createMockExecutionContext = (session?: AuthSession) => {
    const mockRequest = { [AUTH_SESSION_KEY]: session };
    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RoleGuard, Reflector],
    }).compile();

    guard = module.get<RoleGuard>(RoleGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  it("should be defined", () => {
    expect(guard).toBeDefined();
  });

  describe("when no roles are required", () => {
    it("should allow access when @Roles decorator is not present", () => {
      vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined);
      const context = createMockExecutionContext(createMockSession(["user"]));

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should allow access when @Roles decorator has empty array", () => {
      vi.spyOn(reflector, "getAllAndOverride").mockReturnValue([]);
      const context = createMockExecutionContext(createMockSession(["user"]));

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });
  });

  describe("when roles are required", () => {
    it("should allow access when user has one of the required roles", () => {
      vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(["admin", "staff"]);
      const context = createMockExecutionContext(createMockSession(["admin"]));

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should allow access when user has multiple roles including required one", () => {
      vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(["admin"]);
      const context = createMockExecutionContext(createMockSession(["user", "admin"]));

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should deny access when user does not have any required role", () => {
      vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(["admin", "staff"]);
      const context = createMockExecutionContext(createMockSession(["user"]));

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(
        "Access denied. Required roles: admin, staff",
      );
    });

    it("should deny access when user has no roles", () => {
      vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(["admin"]);
      const context = createMockExecutionContext(createMockSession([]));

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe("when session is missing", () => {
    it("should throw ForbiddenException when session is not attached", () => {
      vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(["admin"]);
      const context = createMockExecutionContext(undefined);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(
        "Session not found. Ensure SessionGuard is used before RoleGuard.",
      );
    });
  });

  describe("role combinations", () => {
    it("should allow fleetOwner to access fleet-owner routes", () => {
      vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(["fleetOwner"]);
      const context = createMockExecutionContext(createMockSession(["fleetOwner"]));

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should allow staff to access staff routes", () => {
      vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(["staff"]);
      const context = createMockExecutionContext(createMockSession(["staff"]));

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should allow admin to access admin-only routes", () => {
      vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(["admin"]);
      const context = createMockExecutionContext(createMockSession(["admin"]));

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should deny regular user access to admin routes", () => {
      vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(["admin"]);
      const context = createMockExecutionContext(createMockSession(["user"]));

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it("should deny fleetOwner access to admin routes", () => {
      vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(["admin"]);
      const context = createMockExecutionContext(createMockSession(["fleetOwner"]));

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });
});
