import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReferralInvalidCodeException,
  ReferralUserNotFoundException,
  ReferralValidationFailedException,
} from "./referral.error";
import { ReferralService } from "./referral.service";
import { ReferralApiService } from "./referral-api.service";
import { ReferralProcessingService } from "./referral-processing.service";

describe("ReferralService", () => {
  let service: ReferralService;
  let referralApiService: ReferralApiService;
  let referralProcessingService: ReferralProcessingService;

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
        {
          provide: ReferralProcessingService,
          useValue: {
            queueReferralProcessing: vi.fn(),
            processReferralCompletionForBooking: vi.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ReferralService>(ReferralService);
    referralApiService = module.get<ReferralApiService>(ReferralApiService);
    referralProcessingService = module.get<ReferralProcessingService>(ReferralProcessingService);
  });

  it("delegates queue referral processing", async () => {
    await service.queueReferralProcessing("booking-1");
    expect(referralProcessingService.queueReferralProcessing).toHaveBeenCalledWith("booking-1");
  });

  it("returns normalized validate payload", async () => {
    vi.mocked(referralApiService.validateReferralCode).mockResolvedValue({
      id: "user-1",
      email: "referrer@example.com",
      referralCode: "ABCDEFGH",
      name: null,
    });

    const result = await service.validateReferralCode("ABCDEFGH", {
      email: "new@example.com",
    });

    expect(result).toEqual({
      valid: true,
      referrer: { name: "Anonymous" },
      message: "Valid referral code.",
    });
  });

  it("rethrows known referral errors during validation", async () => {
    const knownError = new ReferralInvalidCodeException();
    vi.mocked(referralApiService.validateReferralCode).mockRejectedValue(knownError);

    await expect(
      service.validateReferralCode("ABCDEFGH", {
        email: "new@example.com",
      }),
    ).rejects.toBe(knownError);
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

    const request = {
      headers: {},
      protocol: "http",
      get: vi.fn().mockReturnValue("localhost:3000"),
    } as never;

    await expect(service.getCurrentUserReferralInfo("user-1", request)).rejects.toBeInstanceOf(
      ReferralUserNotFoundException,
    );
  });
});
