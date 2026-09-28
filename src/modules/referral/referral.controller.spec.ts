import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { AuthService } from "../auth/auth.service";
import { ReferralController } from "./referral.controller";
import { ReferralService } from "./referral.service";

describe("ReferralController", () => {
  let controller: ReferralController;
  let referralService: ReferralService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: "default",
            ttl: 3600,
            limit: 10,
          },
        ]),
      ],
      controllers: [ReferralController],
      providers: [
        {
          provide: ReferralService,
          useValue: {
            validateReferralCode: vi.fn(),
            getReferralEligibility: vi.fn(),
            getCurrentUserReferralInfo: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            isInitialized: true,
            auth: {
              api: {
                getSession: vi.fn().mockResolvedValue(null),
              },
            },
            getUserRoles: vi.fn().mockResolvedValue(["user"]),
          },
        },
        Reflector,
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    controller = module.get<ReferralController>(ReferralController);
    referralService = module.get<ReferralService>(ReferralService);
  });

  it("validates referral code and returns successful payload", async () => {
    vi.mocked(referralService.validateReferralCode).mockResolvedValue({
      valid: true,
      referrer: { name: "Referrer Name" },
      message: "Valid referral code.",
    });

    const response = {
      setHeader: vi.fn(),
    };

    const result = await controller.validateReferralCode(
      "ABCDEFGH",
      { email: "new-user@example.com" },
      response as unknown as Response,
    );

    expect(result).toEqual({
      valid: true,
      referrer: { name: "Referrer Name" },
      message: "Valid referral code.",
    });
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });
});
