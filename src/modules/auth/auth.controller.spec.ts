import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

describe("AuthController", () => {
  let controller: AuthController;
  let authService: AuthService;

  const mockAuthService = {
    isInitialized: true,
    auth: {
      api: {
        getSession: vi.fn(),
      },
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get<AuthService>(AuthService);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("getSession", () => {
    const mockRequest = {
      headers: {
        cookie: "session=test-token",
      },
    } as unknown as Request;

    it("should return session when authenticated", async () => {
      const mockSession = {
        user: { id: "user-123", email: "test@example.com" },
        session: { id: "session-123", expiresAt: new Date() },
      };

      mockAuthService.auth.api.getSession.mockResolvedValueOnce(mockSession);

      const result = await controller.getSession(mockRequest);

      expect(result).toEqual(mockSession);
      expect(mockAuthService.auth.api.getSession).toHaveBeenCalledWith({
        headers: mockRequest.headers,
      });
    });

    it("should throw UnauthorizedException when not authenticated", async () => {
      mockAuthService.auth.api.getSession.mockResolvedValueOnce(null);

      await expect(controller.getSession(mockRequest)).rejects.toThrow(UnauthorizedException);
      await expect(controller.getSession(mockRequest)).rejects.toThrow("Not authenticated");
    });

    it("should throw ServiceUnavailableException when auth not initialized", async () => {
      mockAuthService.isInitialized = false;

      await expect(controller.getSession(mockRequest)).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(controller.getSession(mockRequest)).rejects.toThrow(
        "Authentication service is not configured",
      );

      // Reset for other tests
      mockAuthService.isInitialized = true;
    });
  });
});
