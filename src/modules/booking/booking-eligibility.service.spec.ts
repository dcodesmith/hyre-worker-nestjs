import { Test, type TestingModule } from "@nestjs/testing";
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";
import { createUser } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { ReferralDiscountNoLongerAvailableException } from "./booking.error";
import { BookingEligibilityService } from "./booking-eligibility.service";

describe("BookingEligibilityService", () => {
  it("returns ineligible for guests", async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingEligibilityService,
        {
          provide: DatabaseService,
          useValue: {
            user: { findUnique: vi.fn() },
            referralProgramConfig: { findMany: vi.fn() },
          },
        },
      ],
    }).compile();

    const service = module.get<BookingEligibilityService>(BookingEligibilityService);
    const result = await service.checkPreliminaryReferralEligibility(null);

    expect(result).toEqual({
      eligible: false,
      referrerUserId: null,
      discountAmount: new Decimal(0),
    });
  });

  it("returns eligible with configured discount when user is referred", async () => {
    const databaseService = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            createUser({ referredByUserId: "referrer-1", referralDiscountUsed: false }),
          ),
      },
      referralProgramConfig: {
        findMany: vi.fn().mockResolvedValue([
          { key: "REFERRAL_ENABLED", value: true },
          { key: "REFERRAL_DISCOUNT_AMOUNT", value: "5000" },
        ]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingEligibilityService,
        { provide: DatabaseService, useValue: databaseService },
      ],
    }).compile();

    const service = module.get<BookingEligibilityService>(BookingEligibilityService);
    const result = await service.checkPreliminaryReferralEligibility({
      id: "user-1",
    } as never);

    expect(result).toEqual({
      eligible: true,
      referrerUserId: "referrer-1",
      discountAmount: new Decimal(5000),
    });
  });

  it("throws when discount was already claimed by concurrent transaction", async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingEligibilityService,
        {
          provide: DatabaseService,
          useValue: {
            user: { findUnique: vi.fn() },
            referralProgramConfig: { findMany: vi.fn() },
          },
        },
      ],
    }).compile();

    const service = module.get<BookingEligibilityService>(BookingEligibilityService);

    await expect(
      service.verifyAndClaimReferralDiscountInTransaction(
        {
          $queryRaw: vi
            .fn()
            .mockResolvedValue([
              { id: "user-1", referredByUserId: "referrer-1", referralDiscountUsed: true },
            ]),
          user: { update: vi.fn() },
        } as never,
        "user-1",
        {
          eligible: true,
          referrerUserId: "referrer-1",
          discountAmount: new Decimal(5000),
        },
      ),
    ).rejects.toThrow(ReferralDiscountNoLongerAvailableException);
  });
});
