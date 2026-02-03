import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

describe("AuthController", () => {
  let controller: AuthController;
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
    },
  };

  const createMockAuthService = (isInitialized: boolean) => {
    mockGetSession = vi.fn();
    mockGetUserRoles = vi.fn().mockResolvedValue(["user", "admin"]);
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

  const createMockRequest = (headers: Record<string, string | string[]> = {}): Request =>
    ({ headers }) as unknown as Request;

  describe("getSession", () => {
    describe("when auth is initialized", () => {
      beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
          controllers: [AuthController],
          providers: [{ provide: AuthService, useValue: createMockAuthService(true) }],
        }).compile();

        controller = module.get<AuthController>(AuthController);
      });

      it("should return session with user roles when authenticated", async () => {
        mockGetSession.mockResolvedValueOnce(mockSession);
        const req = createMockRequest({ cookie: "session=token-123" });

        const result = await controller.getSession(req);

        expect(result.user).toEqual(
          expect.objectContaining({
            id: "user-123",
            email: "test@example.com",
            roles: ["user", "admin"],
          }),
        );
        expect(result.session).toBe(mockSession.session);
        expect(mockGetUserRoles).toHaveBeenCalledWith("user-123");
      });

      it("should throw UnauthorizedException when no session exists", async () => {
        mockGetSession.mockResolvedValueOnce(null);
        const req = createMockRequest({ cookie: "session=invalid" });

        await expect(controller.getSession(req)).rejects.toThrow(
          new UnauthorizedException("Not authenticated"),
        );
      });

      it("should pass converted headers to getSession", async () => {
        mockGetSession.mockResolvedValueOnce(mockSession);
        const req = createMockRequest({
          cookie: "session=token-123",
          "accept-language": "en-US",
        });

        await controller.getSession(req);

        expect(mockGetSession).toHaveBeenCalledWith({
          headers: expect.any(Headers),
        });
      });
    });

    describe("when auth is not initialized", () => {
      beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
          controllers: [AuthController],
          providers: [{ provide: AuthService, useValue: createMockAuthService(false) }],
        }).compile();

        controller = module.get<AuthController>(AuthController);
      });

      it("should throw ServiceUnavailableException", async () => {
        const req = createMockRequest();

        await expect(controller.getSession(req)).rejects.toThrow(
          new ServiceUnavailableException(
            "Authentication service is not configured. Contact support.",
          ),
        );
      });
    });
  });
});
