import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
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

    describe("without auth credentials (intentional guest)", () => {
      it("should allow through as guest when no credentials provided", async () => {
        const context = createMockExecutionContext(); // No headers

        const result = await guard.canActivate(context);

        expect(result).toBe(true);
        expect(mockGetSession).not.toHaveBeenCalled(); // No need to call getSession
        expect(mockGetUserRoles).not.toHaveBeenCalled();
        expect(context.getRequest()[AUTH_SESSION_KEY]).toBeUndefined();
      });

      it("should allow through as guest when only non-auth headers provided", async () => {
        const context = createMockExecutionContext({
          "content-type": "application/json",
          "accept": "application/json",
        });

        const result = await guard.canActivate(context);

        expect(result).toBe(true);
        expect(mockGetSession).not.toHaveBeenCalled();
        expect(context.getRequest()[AUTH_SESSION_KEY]).toBeUndefined();
      });
    });

    describe("with auth credentials", () => {
      it("should attach session with roles when valid session exists (cookie auth - dev)", async () => {
        mockGetSession.mockResolvedValueOnce(mockSession);
        const context = createMockExecutionContext({
          cookie: "session_token=token-123",
        });

        const result = await guard.canActivate(context);

        expect(result).toBe(true);
        expect(mockGetSession).toHaveBeenCalled();
        expect(mockGetUserRoles).toHaveBeenCalledWith("user-123");
        expect(context.getRequest()[AUTH_SESSION_KEY]).toEqual({
          user: { ...mockSession.user, roles: mockRoles },
          session: mockSession.session,
        });
      });

      it("should attach session with roles when valid session exists (cookie auth - prod with __Host- prefix)", async () => {
        mockGetSession.mockResolvedValueOnce(mockSession);
        const context = createMockExecutionContext({
          cookie: "__Host-session_token=token-123",
        });

        const result = await guard.canActivate(context);

        expect(result).toBe(true);
        expect(mockGetSession).toHaveBeenCalled();
        expect(mockGetUserRoles).toHaveBeenCalledWith("user-123");
        expect(context.getRequest()[AUTH_SESSION_KEY]).toEqual({
          user: { ...mockSession.user, roles: mockRoles },
          session: mockSession.session,
        });
      });

      it("should attach session with roles when valid session exists (bearer token)", async () => {
        mockGetSession.mockResolvedValueOnce(mockSession);
        const context = createMockExecutionContext({
          authorization: "Bearer some-token",
        });

        const result = await guard.canActivate(context);

        expect(result).toBe(true);
        expect(mockGetSession).toHaveBeenCalled();
        expect(mockGetUserRoles).toHaveBeenCalledWith("user-123");
        expect(context.getRequest()[AUTH_SESSION_KEY]).toEqual({
          user: { ...mockSession.user, roles: mockRoles },
          session: mockSession.session,
        });
      });

      it("should throw UnauthorizedException when credentials provided but session is null", async () => {
        // User has a cookie but session is expired/invalid (getSession returns null)
        mockGetSession.mockResolvedValueOnce(null);
        const context = createMockExecutionContext({
          cookie: "session_token=expired-token",
        });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        await expect(guard.canActivate(context)).rejects.toThrow(
          "Your session has expired or is invalid",
        );

        expect(mockGetSession).toHaveBeenCalled();
        expect(mockGetUserRoles).not.toHaveBeenCalled();
      });

      it("should propagate error when getSession throws", async () => {
        // Network error or auth service error
        mockGetSession.mockRejectedValueOnce(new Error("Auth service unavailable"));
        const context = createMockExecutionContext({
          authorization: "Bearer some-token",
        });

        await expect(guard.canActivate(context)).rejects.toThrow("Auth service unavailable");

        expect(mockGetSession).toHaveBeenCalled();
        expect(context.getRequest()[AUTH_SESSION_KEY]).toBeUndefined();
      });

      it("should propagate error when getUserRoles fails (not silently downgrade to guest)", async () => {
        // Scenario: User has valid session, but getUserRoles fails (e.g., transient DB error)
        // Expected: Error propagates instead of silently treating user as guest
        mockGetSession.mockResolvedValueOnce(mockSession);
        mockGetUserRoles.mockRejectedValueOnce(new Error("Database connection failed"));
        const context = createMockExecutionContext({
          cookie: "session_token=token-123",
        });

        await expect(guard.canActivate(context)).rejects.toThrow("Database connection failed");

        expect(mockGetSession).toHaveBeenCalled();
        expect(mockGetUserRoles).toHaveBeenCalledWith("user-123");
        expect(context.getRequest()[AUTH_SESSION_KEY]).toBeUndefined();
      });

      it("should pass headers to getSession", async () => {
        mockGetSession.mockResolvedValueOnce(mockSession);
        const context = createMockExecutionContext({
          cookie: "session_token=token-123",
          authorization: "Bearer some-token",
        });

        await guard.canActivate(context);

        expect(mockGetSession).toHaveBeenCalledWith({
          headers: expect.any(Headers),
        });
      });
    });
  });

  describe("when auth is not initialized", () => {
    beforeEach(async () => {
      await setupTestModule(false);
    });

    it("should allow through as guest when auth service not initialized", async () => {
      const context = createMockExecutionContext({
        cookie: "session_token=token-123",
      });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(context.getRequest()[AUTH_SESSION_KEY]).toBeUndefined();
    });
  });
});
