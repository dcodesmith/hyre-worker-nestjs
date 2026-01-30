import { ExecutionContext } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth.service";
import type { RoleName } from "../auth.types";
import { OptionalSessionGuard } from "./optional-session.guard";
import { AUTH_SESSION_KEY } from "./session.guard";

describe("OptionalSessionGuard", () => {
  let guard: OptionalSessionGuard;
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
        OptionalSessionGuard,
        { provide: AuthService, useValue: createMockAuthService(isInitialized) },
      ],
    }).compile();

    guard = module.get<OptionalSessionGuard>(OptionalSessionGuard);
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

    it("should return true without session when no session found (guest request)", async () => {
      mockGetSession.mockResolvedValueOnce(null);
      const context = createMockExecutionContext();

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(mockGetUserRoles).not.toHaveBeenCalled();
      expect(context.getRequest()[AUTH_SESSION_KEY]).toBeUndefined();
    });

    it("should return true when session validation throws (treat as guest)", async () => {
      mockGetSession.mockRejectedValueOnce(new Error("Session expired"));
      const context = createMockExecutionContext({ cookie: "session=expired" });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(context.getRequest()[AUTH_SESSION_KEY]).toBeUndefined();
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

    it("should return true and allow request through (guest mode)", async () => {
      const context = createMockExecutionContext();

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(context.getRequest()[AUTH_SESSION_KEY]).toBeUndefined();
    });
  });
});
