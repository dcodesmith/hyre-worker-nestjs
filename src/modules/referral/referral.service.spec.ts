import { Test, type TestingModule } from "@nestjs/testing";
import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  ReferralEligibilityCheckFailedException,
  ReferralUserFetchFailedException,
  ReferralUserNotFoundException,
  ReferralValidationFailedException,
} from "./referral.error";
import { ReferralService } from "./referral.service";
import { ReferralApiService } from "./referral-api.service";

describe("ReferralService", () => {
  let service: ReferralService;
  let referralApiService: ReferralApiService;
  const buildRequest = (origin = "localhost:3000") =>
    ({
      headers: {},
      protocol: "http",
      get: vi.fn().mockReturnValue(origin),
    }) as unknown as Request;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralService,
        {
          provide: ReferralApiService,
          useValue: {
            validateReferralCode: vi.fn(),
            checkReferralEligibility: vi.fn(),
            getUserReferralSummary: vi.fn(),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<ReferralService>(ReferralService);
    referralApiService = module.get<ReferralApiService>(ReferralApiService);
  });

  it("throws generic validation failed error for unknown exceptions", async () => {
    vi.mocked(referralApiService.validateReferralCode).mockRejectedValue(new Error("boom"));

    await expect(
      service.validateReferralCode("ABCDEFGH", {
        email: "new@example.com",
      }),
    ).rejects.toBeInstanceOf(ReferralValidationFailedException);
  });

  it("throws user not found when referral summary is missing", async () => {
    vi.mocked(referralApiService.getUserReferralSummary).mockResolvedValue(null);
    await expect(
      service.getCurrentUserReferralInfo("user-1", buildRequest()),
    ).rejects.toBeInstanceOf(ReferralUserNotFoundException);
  });

  it("throws generic eligibility failed error for unknown exceptions", async () => {
    vi.mocked(referralApiService.checkReferralEligibility).mockRejectedValue(new Error("boom"));

    await expect(
      service.getReferralEligibility("user-1", {
        amount: 20000,
        type: "DAY",
      }),
    ).rejects.toBeInstanceOf(ReferralEligibilityCheckFailedException);
  });

  it("throws generic referral fetch failed for unknown exceptions", async () => {
    vi.mocked(referralApiService.getUserReferralSummary).mockRejectedValue(new Error("boom"));
    await expect(
      service.getCurrentUserReferralInfo("user-1", buildRequest()),
    ).rejects.toBeInstanceOf(ReferralUserFetchFailedException);
  });
});
