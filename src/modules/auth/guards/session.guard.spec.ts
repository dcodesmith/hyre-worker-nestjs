import { ExecutionContext } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  AuthErrorCode,
  AuthServiceUnavailableException,
  AuthUnauthorizedException,
} from "../auth.error";
import type { RoleName } from "../auth.interface";
import { AuthService } from "../auth.service";
import { createMockAuthService } from "../test-utils/auth-test.utils";
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
    mockGetSession = vi.fn();
    mockGetUserRoles = vi.fn().mockResolvedValue(mockRoles);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionGuard,
        {
          provide: AuthService,
          useValue: createMockAuthService({
            isInitialized,
            getSessionMock: mockGetSession,
            getUserRolesMock: mockGetUserRoles,
          }),
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    guard = module.get<SessionGuard>(SessionGuard);
  };

  describe("when auth is initialized", () => {
    beforeEach(async () => {
      await setupTestModule(true);
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

    it("should throw AuthUnauthorizedException when no session found", async () => {
      mockGetSession.mockResolvedValueOnce(null);
      const context = createMockExecutionContext({ cookie: "session=invalid" });

      const resultPromise = guard.canActivate(context);
      await expect(resultPromise).rejects.toThrow(AuthUnauthorizedException);
      await expect(resultPromise).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: AuthErrorCode.AUTH_INVALID_OR_EXPIRED_SESSION,
          title: "Invalid Or Expired Session",
          detail: "Invalid or expired session",
        }),
      });
    });

    it("should rethrow unexpected infrastructure errors from getSession", async () => {
      mockGetSession.mockRejectedValueOnce(new Error("Database unavailable"));
      const context = createMockExecutionContext({ cookie: "session=token-123" });

      await expect(guard.canActivate(context)).rejects.toThrow("Database unavailable");
    });

    it("should throw AuthUnauthorizedException for auth-specific session errors", async () => {
      mockGetSession.mockRejectedValueOnce(new Error("Session expired, please login again"));
      const context = createMockExecutionContext({ cookie: "session=token-123" });

      await expect(guard.canActivate(context)).rejects.toThrow(AuthUnauthorizedException);
    });

    it("should not map infrastructure session errors to AuthUnauthorizedException", async () => {
      mockGetSession.mockRejectedValueOnce(
        new Error("Database session pool timeout while querying Session table"),
      );
      const context = createMockExecutionContext({ cookie: "session=token-123" });

      const resultPromise = guard.canActivate(context);

      await expect(resultPromise).rejects.toThrow(
        "Database session pool timeout while querying Session table",
      );
      await expect(resultPromise).rejects.not.toThrow(AuthUnauthorizedException);
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

    it("should throw AuthServiceUnavailableException", async () => {
      const context = createMockExecutionContext();

      const resultPromise = guard.canActivate(context);
      await expect(resultPromise).rejects.toThrow(AuthServiceUnavailableException);
      await expect(resultPromise).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: AuthErrorCode.AUTH_SERVICE_NOT_CONFIGURED,
          title: "Authentication Service Not Configured",
          detail: "Authentication service is not configured. Contact support.",
        }),
      });
    });
  });
});
