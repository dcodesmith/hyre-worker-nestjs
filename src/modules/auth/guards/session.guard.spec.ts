import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth.service";
import type { RoleName } from "../auth.types";
import { AUTH_SESSION_KEY, SessionGuard } from "./session.guard";

describe("SessionGuard", () => {
  let guard: SessionGuard;
  let mockGetSession: ReturnType<typeof vi.fn>;
  let mockGetUserRoles: ReturnType<typeof vi.fn>;

  const mockSession = {
    user: {
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
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
  };

  const mockRoles: RoleName[] = ["user"];

  const createMockAuthService = (isInitialized: boolean) => {
    mockGetSession = vi.fn();
    mockGetUserRoles = vi.fn().mockResolvedValue(mockRoles);
    return {
      isInitialized,
      auth: {
        api: {
          getSession: mockGetSession,
        },
      },
      getUserRoles: mockGetUserRoles,
    };
  };

  const createMockExecutionContext = (headers: Record<string, string> = {}) => {
    const mockRequest = { headers, [AUTH_SESSION_KEY]: undefined };
    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
      getRequest: () => mockRequest,
    } as unknown as ExecutionContext & { getRequest: () => typeof mockRequest };
  };

  const setupTestModule = async (isInitialized: boolean) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionGuard,
        { provide: AuthService, useValue: createMockAuthService(isInitialized) },
      ],
    }).compile();

    guard = module.get<SessionGuard>(SessionGuard);
  };

  describe("when auth is initialized", () => {
    beforeEach(async () => {
      await setupTestModule(true);
    });

    it("should be defined", () => {
      expect(guard).toBeDefined();
    });

    it("should return true and attach session with roles when valid session exists", async () => {
      mockGetSession.mockResolvedValueOnce(mockSession);
      const context = createMockExecutionContext({ cookie: "session=token-123" });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(mockGetUserRoles).toHaveBeenCalledWith("user-123");
      expect(context.getRequest()[AUTH_SESSION_KEY]).toEqual({
        user: { ...mockSession.user, roles: mockRoles },
        session: mockSession.session,
      });
    });

    it("should throw UnauthorizedException when no session found", async () => {
      mockGetSession.mockResolvedValueOnce(null);
      const context = createMockExecutionContext({ cookie: "session=invalid" });

      await expect(guard.canActivate(context)).rejects.toThrow(
        new UnauthorizedException("Invalid or expired session"),
      );
    });

    it("should pass headers to getSession", async () => {
      mockGetSession.mockResolvedValueOnce(mockSession);
      const context = createMockExecutionContext({
        cookie: "session=token-123",
        authorization: "Bearer some-token",
      });

      await guard.canActivate(context);

      expect(mockGetSession).toHaveBeenCalledWith({
        headers: expect.any(Headers),
      });
    });
  });

  describe("when auth is not initialized", () => {
    beforeEach(async () => {
      await setupTestModule(false);
    });

    it("should throw ServiceUnavailableException", async () => {
      const context = createMockExecutionContext();

      await expect(guard.canActivate(context)).rejects.toThrow(
        new ServiceUnavailableException(
          "Authentication service is not configured. Contact support.",
        ),
      );
    });
  });
});
