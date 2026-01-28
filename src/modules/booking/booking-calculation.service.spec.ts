import { Test, type TestingModule } from "@nestjs/testing";
import { Decimal } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RatesService } from "../rates/rates.service";
import type { BookingCalculationInput, CarPricing } from "./booking-calculation.interface";
import { BookingCalculationService } from "./booking-calculation.service";
import type { GeneratedLeg } from "./booking.interface";

describe("BookingCalculationService", () => {
  let service: BookingCalculationService;
  let ratesService: { getRates: ReturnType<typeof vi.fn> };

  // Standard mock rates
  const mockRates = {
    platformCustomerServiceFeeRatePercent: new Decimal("10.00"), // 10%
    platformFleetOwnerCommissionRatePercent: new Decimal("5.00"), // 5%
    vatRatePercent: new Decimal("7.50"), // 7.5%
    securityDetailRate: new Decimal("5000.00"), // ₦5,000 per leg
  };

  // Standard mock car pricing
  const mockCar: CarPricing = {
    dayRate: 50000, // ₦50,000
    nightRate: 30000, // ₦30,000
    fullDayRate: 80000, // ₦80,000
    airportPickupRate: 25000, // ₦25,000
    hourlyRate: 5000, // ₦5,000
    fuelUpgradeRate: 10000, // ₦10,000
    pricingIncludesFuel: false,
  };

  // Helper to create legs
  const createLegs = (count: number): GeneratedLeg[] => {
    return Array.from({ length: count }, (_, i) => ({
      legDate: new Date(`2025-03-0${i + 1}T00:00:00Z`),
      legStartTime: new Date(`2025-03-0${i + 1}T09:00:00Z`),
      legEndTime: new Date(`2025-03-0${i + 1}T21:00:00Z`),
    }));
  };

  beforeEach(async () => {
    ratesService = {
      getRates: vi.fn().mockResolvedValue(mockRates),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [BookingCalculationService, { provide: RatesService, useValue: ratesService }],
    }).compile();

    service = module.get<BookingCalculationService>(BookingCalculationService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("leg pricing by booking type", () => {
    it("should calculate DAY booking with dayRate", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.legPrices).toHaveLength(2);
      expect(result.legPrices[0].price.equals(new Decimal(50000))).toBe(true);
      expect(result.legPrices[1].price.equals(new Decimal(50000))).toBe(true);
      expect(result.netTotal.equals(new Decimal(100000))).toBe(true); // 50,000 × 2
    });

    it("should calculate NIGHT booking with nightRate", async () => {
      const input: BookingCalculationInput = {
        bookingType: "NIGHT",
        legs: createLegs(3),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.netTotal.equals(new Decimal(90000))).toBe(true); // 30,000 × 3
    });

    it("should calculate FULL_DAY booking with fullDayRate", async () => {
      const input: BookingCalculationInput = {
        bookingType: "FULL_DAY",
        legs: createLegs(2),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.netTotal.equals(new Decimal(160000))).toBe(true); // 80,000 × 2
    });

    it("should calculate AIRPORT_PICKUP booking with airportPickupRate", async () => {
      const input: BookingCalculationInput = {
        bookingType: "AIRPORT_PICKUP",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.netTotal.equals(new Decimal(25000))).toBe(true); // 25,000 × 1
    });
  });

  describe("security detail add-on", () => {
    it("should add security detail cost when requested", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: mockCar,
        includeSecurityDetail: true,
        requiresFullTank: false,
      };

      const result = await service.calculateBookingCost(input);

      // Security: 5,000 × 2 legs = 10,000
      expect(result.securityDetailCost.equals(new Decimal(10000))).toBe(true);
      expect(result.netTotalWithAddons.equals(new Decimal(110000))).toBe(true); // 100,000 + 10,000
    });

    it("should not add security detail cost when not requested", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.securityDetailCost.equals(new Decimal(0))).toBe(true);
    });
  });

  describe("fuel upgrade add-on", () => {
    it("should add fuel upgrade cost when all conditions are met", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2), // <= 2 legs
        car: { ...mockCar, pricingIncludesFuel: false },
        includeSecurityDetail: false,
        requiresFullTank: true,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.fuelUpgradeCost.equals(new Decimal(10000))).toBe(true);
    });

    it("should NOT add fuel upgrade when car pricing includes fuel", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: { ...mockCar, pricingIncludesFuel: true },
        includeSecurityDetail: false,
        requiresFullTank: true,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.fuelUpgradeCost.equals(new Decimal(0))).toBe(true);
    });

    it("should NOT add fuel upgrade when customer does not request full tank", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.fuelUpgradeCost.equals(new Decimal(0))).toBe(true);
    });

    it("should NOT add fuel upgrade when booking has more than 2 legs", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(3), // > 2 legs
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: true,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.fuelUpgradeCost.equals(new Decimal(0))).toBe(true);
    });

    it("should NOT add fuel upgrade when fuelUpgradeRate is null", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: { ...mockCar, fuelUpgradeRate: null },
        includeSecurityDetail: false,
        requiresFullTank: true,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.fuelUpgradeCost.equals(new Decimal(0))).toBe(true);
    });

    it("should NOT add fuel upgrade when fuelUpgradeRate is 0", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: { ...mockCar, fuelUpgradeRate: 0 },
        includeSecurityDetail: false,
        requiresFullTank: true,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.fuelUpgradeCost.equals(new Decimal(0))).toBe(true);
    });
  });

  describe("platform fee calculation", () => {
    it("should calculate platform fee on netTotal + fuelUpgrade (excluding security)", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: mockCar,
        includeSecurityDetail: true, // Should NOT affect platform fee base
        requiresFullTank: true, // Should affect platform fee base
      };

      const result = await service.calculateBookingCost(input);

      // Net: 100,000, Fuel: 10,000, Security: 10,000
      // Platform fee base: 100,000 + 10,000 = 110,000 (excludes security)
      // Platform fee: 110,000 × 10% = 11,000
      expect(result.platformFeeBase.equals(new Decimal(110000))).toBe(true);
      expect(result.platformCustomerServiceFeeAmount.equals(new Decimal(11000))).toBe(true);
    });

    it("should store platform fee rate percentage", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.platformCustomerServiceFeeRatePercent.equals(new Decimal(10))).toBe(true);
    });
  });

  describe("subtotal before discounts", () => {
    it("should calculate subtotal as netTotalWithAddons + platformFee", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: mockCar,
        includeSecurityDetail: true,
        requiresFullTank: true,
      };

      const result = await service.calculateBookingCost(input);

      // Net: 100,000
      // Security: 10,000
      // Fuel: 10,000
      // NetWithAddons: 120,000
      // Platform fee base: 110,000 (net + fuel)
      // Platform fee: 11,000
      // Subtotal: 120,000 + 11,000 = 131,000
      expect(result.subtotalBeforeDiscounts.equals(new Decimal(131000))).toBe(true);
    });
  });

  describe("referral discount", () => {
    it("should apply referral discount", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
        referralDiscountAmount: new Decimal(5000),
      };

      const result = await service.calculateBookingCost(input);

      expect(result.referralDiscountAmount.equals(new Decimal(5000))).toBe(true);
    });

    it("should cap referral discount at subtotal (cannot go negative)", async () => {
      const input: BookingCalculationInput = {
        bookingType: "AIRPORT_PICKUP",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
        referralDiscountAmount: new Decimal(999999), // Way more than subtotal
      };

      const result = await service.calculateBookingCost(input);

      // Net: 25,000, Platform fee: 2,500, Subtotal: 27,500
      // Referral capped at 27,500
      expect(result.referralDiscountAmount.equals(result.subtotalBeforeDiscounts)).toBe(true);
      expect(result.subtotalAfterDiscounts.equals(new Decimal(0))).toBe(true);
    });

    it("should handle zero referral discount", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
        referralDiscountAmount: new Decimal(0),
      };

      const result = await service.calculateBookingCost(input);

      expect(result.referralDiscountAmount.equals(new Decimal(0))).toBe(true);
    });

    it("should handle undefined referral discount", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.referralDiscountAmount.equals(new Decimal(0))).toBe(true);
    });
  });

  describe("credits usage", () => {
    it("should apply credits when available", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
        userCreditsBalance: new Decimal(10000),
        creditsToUse: new Decimal(5000),
      };

      const result = await service.calculateBookingCost(input);

      expect(result.creditsUsed.equals(new Decimal(5000))).toBe(true);
    });

    it("should cap credits at user balance", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
        userCreditsBalance: new Decimal(3000), // Only 3,000 available
        creditsToUse: new Decimal(5000), // Trying to use 5,000
      };

      const result = await service.calculateBookingCost(input);

      expect(result.creditsUsed.equals(new Decimal(3000))).toBe(true); // Capped at balance
    });

    it("should cap credits at remaining subtotal after referral discount", async () => {
      const input: BookingCalculationInput = {
        bookingType: "AIRPORT_PICKUP",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
        referralDiscountAmount: new Decimal(20000), // Leaves 7,500 remaining
        userCreditsBalance: new Decimal(50000),
        creditsToUse: new Decimal(50000), // Trying to use all
      };

      const result = await service.calculateBookingCost(input);

      // Net: 25,000, Platform fee: 2,500, Subtotal: 27,500
      // After referral: 27,500 - 20,000 = 7,500
      // Credits capped at 7,500
      expect(result.creditsUsed.equals(new Decimal(7500))).toBe(true);
    });

    it("should handle zero credits", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
        userCreditsBalance: new Decimal(10000),
        creditsToUse: new Decimal(0),
      };

      const result = await service.calculateBookingCost(input);

      expect(result.creditsUsed.equals(new Decimal(0))).toBe(true);
    });
  });

  describe("VAT calculation", () => {
    it("should calculate VAT on subtotal after discounts", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
      };

      const result = await service.calculateBookingCost(input);

      // Net: 50,000, Platform fee: 5,000, Subtotal: 55,000
      // No discounts, so subtotal after = 55,000
      // VAT: 55,000 × 7.5% = 4,125
      expect(result.vatRatePercent.equals(new Decimal(7.5))).toBe(true);
      expect(result.vatAmount.equals(new Decimal(4125))).toBe(true);
    });

    it("should calculate VAT after applying discounts", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
        referralDiscountAmount: new Decimal(5000),
      };

      const result = await service.calculateBookingCost(input);

      // Net: 50,000, Platform fee: 5,000, Subtotal: 55,000
      // After referral: 55,000 - 5,000 = 50,000
      // VAT: 50,000 × 7.5% = 3,750
      expect(result.vatAmount.equals(new Decimal(3750))).toBe(true);
    });
  });

  describe("total amount", () => {
    it("should calculate total as subtotalAfterDiscounts + VAT", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
      };

      const result = await service.calculateBookingCost(input);

      // Subtotal: 55,000, VAT: 4,125
      // Total: 55,000 + 4,125 = 59,125
      expect(result.totalAmount.equals(new Decimal(59125))).toBe(true);
    });
  });

  describe("fleet owner commission and payout", () => {
    it("should calculate fleet owner commission on platformFeeBase", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: mockCar,
        includeSecurityDetail: true,
        requiresFullTank: true,
      };

      const result = await service.calculateBookingCost(input);

      // Platform fee base: 110,000 (net + fuel, excludes security)
      // Commission: 110,000 × 5% = 5,500
      expect(result.platformFleetOwnerCommissionRatePercent.equals(new Decimal(5))).toBe(true);
      expect(result.platformFleetOwnerCommissionAmount.equals(new Decimal(5500))).toBe(true);
    });

    it("should calculate fleet owner payout (netTotal + security - commission)", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: mockCar,
        includeSecurityDetail: true,
        requiresFullTank: true,
      };

      const result = await service.calculateBookingCost(input);

      // Net: 100,000
      // Security: 10,000
      // Commission: 5,500
      // Payout: 100,000 + 10,000 - 5,500 = 104,500
      expect(result.fleetOwnerPayoutAmountNet.equals(new Decimal(104500))).toBe(true);
    });

    it("should NOT include fuel upgrade in fleet owner payout", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: true, // Fuel upgrade applies
      };

      const result = await service.calculateBookingCost(input);

      // Net: 100,000
      // Fuel: 10,000 (NOT included in payout)
      // Commission: 110,000 × 5% = 5,500
      // Payout: 100,000 - 5,500 = 94,500 (fuel NOT included)
      expect(result.fleetOwnerPayoutAmountNet.equals(new Decimal(94500))).toBe(true);
    });
  });

  describe("complete calculation scenario", () => {
    it("should correctly calculate a complete booking with all options", async () => {
      const input: BookingCalculationInput = {
        bookingType: "DAY",
        legs: createLegs(2),
        car: mockCar,
        includeSecurityDetail: true,
        requiresFullTank: true,
        referralDiscountAmount: new Decimal(10000),
        userCreditsBalance: new Decimal(20000),
        creditsToUse: new Decimal(5000),
      };

      const result = await service.calculateBookingCost(input);

      // Step 1: Leg pricing
      // Net: 50,000 × 2 = 100,000
      expect(result.netTotal.equals(new Decimal(100000))).toBe(true);

      // Step 2: Add-ons
      // Security: 5,000 × 2 = 10,000
      // Fuel: 10,000
      // NetWithAddons: 100,000 + 10,000 + 10,000 = 120,000
      expect(result.securityDetailCost.equals(new Decimal(10000))).toBe(true);
      expect(result.fuelUpgradeCost.equals(new Decimal(10000))).toBe(true);
      expect(result.netTotalWithAddons.equals(new Decimal(120000))).toBe(true);

      // Step 3: Platform fee
      // Base: 100,000 + 10,000 = 110,000 (excludes security)
      // Fee: 110,000 × 10% = 11,000
      expect(result.platformFeeBase.equals(new Decimal(110000))).toBe(true);
      expect(result.platformCustomerServiceFeeAmount.equals(new Decimal(11000))).toBe(true);

      // Step 4: Subtotal before discounts
      // 120,000 + 11,000 = 131,000
      expect(result.subtotalBeforeDiscounts.equals(new Decimal(131000))).toBe(true);

      // Step 5: Apply discounts
      // Referral: 10,000
      // After referral: 131,000 - 10,000 = 121,000
      // Credits: 5,000
      // After credits: 121,000 - 5,000 = 116,000
      expect(result.referralDiscountAmount.equals(new Decimal(10000))).toBe(true);
      expect(result.creditsUsed.equals(new Decimal(5000))).toBe(true);
      expect(result.subtotalAfterDiscounts.equals(new Decimal(116000))).toBe(true);

      // Step 6: VAT
      // 116,000 × 7.5% = 8,700
      expect(result.vatAmount.equals(new Decimal(8700))).toBe(true);

      // Step 7: Total
      // 116,000 + 8,700 = 124,700
      expect(result.totalAmount.equals(new Decimal(124700))).toBe(true);

      // Step 8: Fleet owner
      // Commission: 110,000 × 5% = 5,500
      // Payout: 100,000 + 10,000 - 5,500 = 104,500
      expect(result.platformFleetOwnerCommissionAmount.equals(new Decimal(5500))).toBe(true);
      expect(result.fleetOwnerPayoutAmountNet.equals(new Decimal(104500))).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle single leg booking", async () => {
      const input: BookingCalculationInput = {
        bookingType: "AIRPORT_PICKUP",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
      };

      const result = await service.calculateBookingCost(input);

      expect(result.numberOfLegs).toBe(1);
      expect(result.legPrices).toHaveLength(1);
    });

    it("should handle booking with all discounts exceeding subtotal", async () => {
      const input: BookingCalculationInput = {
        bookingType: "AIRPORT_PICKUP",
        legs: createLegs(1),
        car: mockCar,
        includeSecurityDetail: false,
        requiresFullTank: false,
        referralDiscountAmount: new Decimal(999999),
        userCreditsBalance: new Decimal(999999),
        creditsToUse: new Decimal(999999),
      };

      const result = await service.calculateBookingCost(input);

      // Subtotal should be 0, not negative
      expect(result.subtotalAfterDiscounts.gte(new Decimal(0))).toBe(true);
      // VAT on 0 should be 0
      expect(result.vatAmount.equals(new Decimal(0))).toBe(true);
      // Total should be 0
      expect(result.totalAmount.equals(new Decimal(0))).toBe(true);
    });
  });
});
