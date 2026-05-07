import { Test, TestingModule } from "@nestjs/testing";
import { BookingType } from "@prisma/client";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import type { BookingFinancials } from "./booking-calculation.interface";
import { BookingCalculationService } from "./booking-calculation.service";
import { BookingLegService } from "./booking-leg.service";
import { BookingPersistenceService } from "./booking-persistence.service";
import { BookingPricingPreviewService } from "./booking-pricing-preview.service";

describe("BookingPricingPreviewService", () => {
  let service: BookingPricingPreviewService;
  let bookingPersistenceService: BookingPersistenceService;
  let bookingLegService: BookingLegService;
  let bookingCalculationService: BookingCalculationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPricingPreviewService,
        {
          provide: BookingPersistenceService,
          useValue: {
            fetchCarWithPricing: vi.fn(),
          },
        },
        {
          provide: BookingLegService,
          useValue: {
            generateLegs: vi.fn(),
          },
        },
        {
          provide: BookingCalculationService,
          useValue: {
            calculateBookingCost: vi.fn(),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<BookingPricingPreviewService>(BookingPricingPreviewService);
    bookingPersistenceService = module.get<BookingPersistenceService>(BookingPersistenceService);
    bookingLegService = module.get<BookingLegService>(BookingLegService);
    bookingCalculationService = module.get<BookingCalculationService>(BookingCalculationService);
  });

  it("returns PARTIAL coverage and promo/standard segments", async () => {
    vi.mocked(bookingPersistenceService.fetchCarWithPricing).mockResolvedValue({
      id: "car-1",
      ownerId: "owner-1",
      dayRate: 50000,
      nightRate: 45000,
      fullDayRate: 80000,
      airportPickupRate: 60000,
      fuelUpgradeRate: 0,
      pricingIncludesFuel: false,
    });
    vi.mocked(bookingLegService.generateLegs).mockReturnValue([
      {
        legDate: new Date("2026-05-01T00:00:00.000Z"),
        legStartTime: new Date("2026-05-01T09:00:00.000Z"),
        legEndTime: new Date("2026-05-01T21:00:00.000Z"),
      },
      {
        legDate: new Date("2026-05-02T00:00:00.000Z"),
        legStartTime: new Date("2026-05-02T09:00:00.000Z"),
        legEndTime: new Date("2026-05-02T21:00:00.000Z"),
      },
      {
        legDate: new Date("2026-05-03T00:00:00.000Z"),
        legStartTime: new Date("2026-05-03T09:00:00.000Z"),
        legEndTime: new Date("2026-05-03T21:00:00.000Z"),
      },
    ]);

    const financials: BookingFinancials = {
      legPrices: [
        {
          legDate: new Date("2026-05-01T00:00:00.000Z"),
          price: new Decimal(40000),
          basePrice: new Decimal(50000),
          promotion: {
            id: "promo-1",
            name: "Launch",
            discountValue: new Decimal(20),
            startDate: new Date("2026-05-01T00:00:00.000Z"),
            endDate: new Date("2026-05-02T00:00:00.000Z"),
          },
        },
        {
          legDate: new Date("2026-05-02T00:00:00.000Z"),
          price: new Decimal(50000),
          basePrice: new Decimal(50000),
          promotion: null,
        },
        {
          legDate: new Date("2026-05-03T00:00:00.000Z"),
          price: new Decimal(50000),
          basePrice: new Decimal(50000),
          promotion: null,
        },
      ],
      numberOfLegs: 3,
      netTotal: new Decimal(140000),
      compareAtNetTotal: new Decimal(150000),
      appliedPromotion: null,
      securityDetailCost: new Decimal(0),
      fuelUpgradeCost: new Decimal(0),
      netTotalWithAddons: new Decimal(140000),
      platformFeeBase: new Decimal(140000),
      platformCustomerServiceFeeRatePercent: new Decimal(5),
      platformCustomerServiceFeeAmount: new Decimal(7000),
      subtotalBeforeDiscounts: new Decimal(147000),
      referralDiscountAmount: new Decimal(0),
      creditsUsed: new Decimal(0),
      subtotalAfterDiscounts: new Decimal(147000),
      vatRatePercent: new Decimal(7.5),
      vatAmount: new Decimal(11025),
      totalAmount: new Decimal(158025),
      platformFleetOwnerCommissionRatePercent: new Decimal(5),
      platformFleetOwnerCommissionAmount: new Decimal(7000),
      fleetOwnerPayoutAmountNet: new Decimal(133000),
    };
    vi.mocked(bookingCalculationService.calculateBookingCost).mockResolvedValue(financials);

    const result = await service.preview({
      carId: "car-1",
      bookingType: BookingType.DAY,
      startDate: new Date("2026-05-01T00:00:00.000Z"),
      endDate: new Date("2026-05-03T23:59:00.000Z"),
      pickupTime: "9:00 AM",
      includeSecurityDetail: false,
      requiresFullTank: false,
    });

    expect(result.discountCoverage).toBe("PARTIAL");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({
      kind: "PROMO",
      units: 1,
      unitPrice: 40000,
      compareAtUnitPrice: 50000,
      promotion: {
        id: "promo-1",
        name: "Launch",
        discountValue: 20,
      },
    });
    expect(result.segments[1]).toMatchObject({
      kind: "STANDARD",
      units: 2,
      unitPrice: 50000,
      total: 100000,
      compareAtUnitPrice: null,
    });
    expect(result.compareAtBaseTotal).toBe(150000);
    expect(result.baseTotal).toBe(140000);
    expect(result.savingsAmount).toBeGreaterThan(0);
  });

  it("handles AIRPORT_PICKUP preview flow", async () => {
    vi.mocked(bookingPersistenceService.fetchCarWithPricing).mockResolvedValue({
      id: "car-1",
      ownerId: "owner-1",
      dayRate: 50000,
      nightRate: 45000,
      fullDayRate: 80000,
      airportPickupRate: 60000,
      fuelUpgradeRate: 0,
      pricingIncludesFuel: false,
    });

    vi.mocked(bookingLegService.generateLegs).mockReturnValue([
      {
        legDate: new Date("2026-05-01T00:00:00.000Z"),
        legStartTime: new Date("2026-05-01T10:00:00.000Z"),
        legEndTime: new Date("2026-05-01T12:00:00.000Z"),
      },
    ]);

    const financials: BookingFinancials = {
      legPrices: [
        {
          legDate: new Date("2026-05-01T00:00:00.000Z"),
          price: new Decimal(60000),
          basePrice: new Decimal(60000),
          promotion: null,
        },
      ],
      numberOfLegs: 1,
      netTotal: new Decimal(60000),
      compareAtNetTotal: new Decimal(60000),
      appliedPromotion: null,
      securityDetailCost: new Decimal(0),
      fuelUpgradeCost: new Decimal(0),
      netTotalWithAddons: new Decimal(60000),
      platformFeeBase: new Decimal(60000),
      platformCustomerServiceFeeRatePercent: new Decimal(5),
      platformCustomerServiceFeeAmount: new Decimal(3000),
      subtotalBeforeDiscounts: new Decimal(63000),
      referralDiscountAmount: new Decimal(0),
      creditsUsed: new Decimal(0),
      subtotalAfterDiscounts: new Decimal(63000),
      vatRatePercent: new Decimal(7.5),
      vatAmount: new Decimal(4725),
      totalAmount: new Decimal(67725),
      platformFleetOwnerCommissionRatePercent: new Decimal(5),
      platformFleetOwnerCommissionAmount: new Decimal(3000),
      fleetOwnerPayoutAmountNet: new Decimal(57000),
    };
    vi.mocked(bookingCalculationService.calculateBookingCost).mockResolvedValue(financials);

    const result = await service.preview({
      carId: "car-1",
      bookingType: BookingType.AIRPORT_PICKUP,
      startDate: new Date("2026-05-01T00:00:00.000Z"),
      endDate: new Date("2026-05-01T03:00:00.000Z"),
      pickupTime: "10:00 AM",
      includeSecurityDetail: false,
      requiresFullTank: false,
    });

    expect(bookingLegService.generateLegs).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingType: BookingType.AIRPORT_PICKUP,
      }),
    );
    expect(result.discountCoverage).toBe("NONE");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      kind: "STANDARD",
      units: 1,
      unitPrice: 60000,
      total: 60000,
    });
  });
});
