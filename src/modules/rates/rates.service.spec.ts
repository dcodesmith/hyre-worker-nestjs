import { Test, type TestingModule } from "@nestjs/testing";
import { Decimal } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { RatesService } from "./rates.service";

describe("RatesService", () => {
  let service: RatesService;
  let databaseService: {
    platformFeeRate: { findMany: ReturnType<typeof vi.fn> };
    taxRate: { findFirst: ReturnType<typeof vi.fn> };
    addonRate: { findFirst: ReturnType<typeof vi.fn> };
  };

  const mockPlatformRates = [
    {
      id: "rate-1",
      feeType: "PLATFORM_SERVICE_FEE",
      ratePercent: new Decimal("10.00"),
      effectiveSince: new Date("2024-01-01"),
      effectiveUntil: null,
    },
    {
      id: "rate-2",
      feeType: "FLEET_OWNER_COMMISSION",
      ratePercent: new Decimal("5.00"),
      effectiveSince: new Date("2024-01-01"),
      effectiveUntil: null,
    },
  ];

  const mockVatRate = {
    id: "vat-1",
    ratePercent: new Decimal("7.50"),
    effectiveSince: new Date("2024-01-01"),
    effectiveUntil: null,
    description: "Nigerian VAT",
  };

  const mockSecurityDetailRate = {
    id: "addon-1",
    addonType: "SECURITY_DETAIL",
    rateAmount: new Decimal("5000.00"),
    effectiveSince: new Date("2024-01-01"),
    effectiveUntil: null,
  };

  beforeEach(async () => {
    databaseService = {
      platformFeeRate: { findMany: vi.fn() },
      taxRate: { findFirst: vi.fn() },
      addonRate: { findFirst: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RatesService, { provide: DatabaseService, useValue: databaseService }],
    }).compile();

    service = module.get<RatesService>(RatesService);

    // Reset mocks to default successful responses
    databaseService.platformFeeRate.findMany.mockResolvedValue(mockPlatformRates);
    databaseService.taxRate.findFirst.mockResolvedValue(mockVatRate);
    databaseService.addonRate.findFirst.mockResolvedValue(mockSecurityDetailRate);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("getRates", () => {
    it("should fetch and return all platform rates", async () => {
      const rates = await service.getRates();

      expect(rates).toEqual({
        platformCustomerServiceFeeRatePercent: new Decimal("10.00"),
        platformFleetOwnerCommissionRatePercent: new Decimal("5.00"),
        vatRatePercent: new Decimal("7.50"),
        securityDetailRate: new Decimal("5000.00"),
      });

      expect(databaseService.platformFeeRate.findMany).toHaveBeenCalledTimes(1);
      expect(databaseService.taxRate.findFirst).toHaveBeenCalledTimes(1);
      expect(databaseService.addonRate.findFirst).toHaveBeenCalledTimes(1);
    });

    it("should cache rates and return cached data on subsequent calls", async () => {
      // First call - fetches from database
      const rates1 = await service.getRates();

      // Second call - should use cache
      const rates2 = await service.getRates();

      expect(rates1).toEqual(rates2);
      expect(databaseService.platformFeeRate.findMany).toHaveBeenCalledTimes(1);
      expect(databaseService.taxRate.findFirst).toHaveBeenCalledTimes(1);
      expect(databaseService.addonRate.findFirst).toHaveBeenCalledTimes(1);
    });

    it("should throw error when platform service fee rate is not found", async () => {
      databaseService.platformFeeRate.findMany.mockResolvedValue([
        mockPlatformRates[1], // Only fleet owner commission, no service fee
      ]);

      await expect(service.getRates()).rejects.toThrow("No active platform service fee rate found");
    });

    it("should throw error when fleet owner commission rate is not found", async () => {
      databaseService.platformFeeRate.findMany.mockResolvedValue([
        mockPlatformRates[0], // Only service fee, no commission
      ]);

      await expect(service.getRates()).rejects.toThrow(
        "No active fleet owner commission rate found",
      );
    });

    it("should throw error when VAT rate is not found", async () => {
      databaseService.taxRate.findFirst.mockResolvedValue(null);

      await expect(service.getRates()).rejects.toThrow("No active VAT rate found");
    });

    it("should throw error when security detail rate is not found", async () => {
      databaseService.addonRate.findFirst.mockResolvedValue(null);

      await expect(service.getRates()).rejects.toThrow("No active security detail rate found");
    });

    it("should query with correct effective date filters", async () => {
      vi.useFakeTimers();
      const fixedDate = new Date("2024-06-15T12:00:00Z");
      vi.setSystemTime(fixedDate);

      await service.getRates();

      expect(databaseService.platformFeeRate.findMany).toHaveBeenCalledWith({
        where: {
          feeType: { in: ["PLATFORM_SERVICE_FEE", "FLEET_OWNER_COMMISSION"] },
          effectiveSince: { lte: fixedDate },
          OR: [{ effectiveUntil: { gt: fixedDate } }, { effectiveUntil: null }],
        },
        orderBy: { effectiveSince: "desc" },
      });

      vi.useRealTimers();
    });
  });

  describe("clearCache", () => {
    it("should clear the cache and force re-fetch on next getRates call", async () => {
      // First call - fetches from database
      await service.getRates();
      expect(databaseService.platformFeeRate.findMany).toHaveBeenCalledTimes(1);

      // Clear cache
      service.clearCache();

      // Second call - should fetch again
      await service.getRates();
      expect(databaseService.platformFeeRate.findMany).toHaveBeenCalledTimes(2);
    });
  });
});
