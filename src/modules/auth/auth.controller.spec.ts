import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import type { RoleName } from "./auth.types";

describe("AuthController", () => {
  let controller: AuthController;
  let mockGetSession: ReturnType<typeof vi.fn>;
  let mockGetUserRoles: ReturnType<typeof vi.fn>;

  const mockRequest = {
    headers: {
      cookie: "session=test-token",
    },
  } as unknown as Request;

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

  const setupTestModule = async (isInitialized: boolean) => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: createMockAuthService(isInitialized),
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  };

  describe("when auth is initialized", () => {
    beforeEach(async () => {
      await setupTestModule(true);
    });

    it("should be defined", () => {
      expect(controller).toBeDefined();
    });

    describe("getSession", () => {
      it("should return session with roles when authenticated", async () => {
        const mockSession = {
          user: { id: "user-123", email: "test@example.com" },
          session: { id: "session-123", expiresAt: new Date() },
        };

        mockGetSession.mockResolvedValueOnce(mockSession);

        const result = await controller.getSession(mockRequest);

        expect(result).toEqual({
          user: { ...mockSession.user, roles: mockRoles },
          session: mockSession.session,
        });
        expect(mockGetSession).toHaveBeenCalledWith({
          headers: expect.any(Headers),
        });
        expect(mockGetUserRoles).toHaveBeenCalledWith("user-123");
      });

      it("should throw UnauthorizedException when not authenticated", async () => {
        mockGetSession.mockResolvedValueOnce(null);

        await expect(controller.getSession(mockRequest)).rejects.toThrow(
          new UnauthorizedException("Not authenticated"),
        );
      });
    });
  });

  describe("when auth is not initialized", () => {
    beforeEach(async () => {
      await setupTestModule(false);
    });

    it("should throw ServiceUnavailableException on getSession", async () => {
      await expect(controller.getSession(mockRequest)).rejects.toThrow(
        new ServiceUnavailableException(
          "Authentication service is not configured. Contact support.",
        ),
      );
    });
  });
});
