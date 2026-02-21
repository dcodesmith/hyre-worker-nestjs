import { Test, type TestingModule } from "@nestjs/testing";
import { Decimal } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import {
  RateAlreadyEndedException,
  RateDateOverlapException,
  RateNotFoundException,
} from "./rates.error";
import { RatesService } from "./rates.service";
import { RatesAdminService } from "./rates-admin.service";

describe("RatesAdminService", () => {
  let service: RatesAdminService;
  let databaseService: {
    platformFeeRate: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    taxRate: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    addonRate: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let ratesService: { clearCache: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    databaseService = {
      platformFeeRate: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      taxRate: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      addonRate: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    };

    ratesService = { clearCache: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RatesAdminService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: RatesService, useValue: ratesService },
      ],
    }).compile();

    service = module.get<RatesAdminService>(RatesAdminService);
  });

  describe("getAllRates", () => {
    it("should return all rates with active status", async () => {
      const past = new Date("2024-01-01");

      databaseService.platformFeeRate.findMany.mockResolvedValue([
        {
          id: "pf-1",
          feeType: "PLATFORM_SERVICE_FEE",
          ratePercent: new Decimal("10.00"),
          effectiveSince: past,
          effectiveUntil: null,
        },
      ]);
      databaseService.taxRate.findMany.mockResolvedValue([
        {
          id: "vat-1",
          ratePercent: new Decimal("7.50"),
          effectiveSince: past,
          effectiveUntil: null,
        },
      ]);
      databaseService.addonRate.findMany.mockResolvedValue([
        {
          id: "addon-1",
          addonType: "SECURITY_DETAIL",
          rateAmount: new Decimal("5000.00"),
          effectiveSince: past,
          effectiveUntil: null,
        },
      ]);

      const result = await service.getAllRates();

      expect(result.platformFeeRates).toHaveLength(1);
      expect(result.platformFeeRates[0].ratePercent).toBe(10);
      expect(result.platformFeeRates[0].active).toBe(true);
      expect(result.taxRates).toHaveLength(1);
      expect(result.taxRates[0].ratePercent).toBe(7.5);
      expect(result.addonRates).toHaveLength(1);
      expect(result.addonRates[0].rateAmount).toBe(5000);
    });

    it("should mark expired rates as inactive", async () => {
      const past = new Date("2024-01-01");
      const expired = new Date("2024-06-01");

      databaseService.platformFeeRate.findMany.mockResolvedValue([
        {
          id: "pf-1",
          feeType: "PLATFORM_SERVICE_FEE",
          ratePercent: new Decimal("10.00"),
          effectiveSince: past,
          effectiveUntil: expired,
        },
      ]);
      databaseService.taxRate.findMany.mockResolvedValue([]);
      databaseService.addonRate.findMany.mockResolvedValue([]);

      const result = await service.getAllRates();

      expect(result.platformFeeRates[0].active).toBe(false);
    });
  });

  describe("createPlatformFeeRate", () => {
    const validDto = {
      feeType: "PLATFORM_SERVICE_FEE" as const,
      ratePercent: 10,
      effectiveSince: new Date("2026-03-01"),
      description: "New service fee",
    };

    it("should create a platform fee rate and clear cache", async () => {
      databaseService.platformFeeRate.create.mockResolvedValue({
        id: "pf-new",
        ...validDto,
        ratePercent: new Decimal("10.00"),
        effectiveUntil: null,
      });

      const result = await service.createPlatformFeeRate(validDto);

      expect(result.id).toBe("pf-new");
      expect(result.ratePercent).toBe(10);
      expect(ratesService.clearCache).toHaveBeenCalledOnce();
    });

    it("should throw on date overlap", async () => {
      databaseService.platformFeeRate.findFirst.mockResolvedValue({ id: "existing" });

      await expect(service.createPlatformFeeRate(validDto)).rejects.toBeInstanceOf(
        RateDateOverlapException,
      );
    });
  });

  describe("createVatRate", () => {
    const validDto = {
      ratePercent: 7.5,
      effectiveSince: new Date("2026-03-01"),
    };

    it("should create a VAT rate and clear cache", async () => {
      databaseService.taxRate.create.mockResolvedValue({
        id: "vat-new",
        ...validDto,
        ratePercent: new Decimal("7.50"),
        effectiveUntil: null,
      });

      const result = await service.createVatRate(validDto);

      expect(result.id).toBe("vat-new");
      expect(result.ratePercent).toBe(7.5);
      expect(ratesService.clearCache).toHaveBeenCalledOnce();
    });

    it("should throw on date overlap", async () => {
      databaseService.taxRate.findFirst.mockResolvedValue({ id: "existing" });

      await expect(service.createVatRate(validDto)).rejects.toBeInstanceOf(
        RateDateOverlapException,
      );
    });
  });

  describe("createAddonRate", () => {
    const validDto = {
      addonType: "SECURITY_DETAIL" as const,
      rateAmount: 5000,
      effectiveSince: new Date("2026-03-01"),
    };

    it("should create an addon rate and clear cache", async () => {
      databaseService.addonRate.create.mockResolvedValue({
        id: "addon-new",
        ...validDto,
        rateAmount: new Decimal("5000.00"),
        effectiveUntil: null,
      });

      const result = await service.createAddonRate(validDto);

      expect(result.id).toBe("addon-new");
      expect(result.rateAmount).toBe(5000);
      expect(ratesService.clearCache).toHaveBeenCalledOnce();
    });

    it("should throw on date overlap", async () => {
      databaseService.addonRate.findFirst.mockResolvedValue({ id: "existing" });

      await expect(service.createAddonRate(validDto)).rejects.toBeInstanceOf(
        RateDateOverlapException,
      );
    });
  });

  describe("endAddonRate", () => {
    it("should end an active addon rate and clear cache", async () => {
      databaseService.addonRate.findUnique.mockResolvedValue({
        id: "addon-1",
        effectiveUntil: null,
      });
      databaseService.addonRate.update.mockResolvedValue({
        id: "addon-1",
        rateAmount: new Decimal("5000.00"),
        effectiveUntil: new Date(),
      });

      const result = await service.endAddonRate("addon-1");

      expect(result.rateAmount).toBe(5000);
      expect(databaseService.addonRate.update).toHaveBeenCalledWith({
        where: { id: "addon-1" },
        data: { effectiveUntil: expect.any(Date) },
      });
      expect(ratesService.clearCache).toHaveBeenCalledOnce();
    });

    it("should throw RateNotFoundException when addon rate does not exist", async () => {
      databaseService.addonRate.findUnique.mockResolvedValue(null);

      await expect(service.endAddonRate("nonexistent")).rejects.toBeInstanceOf(
        RateNotFoundException,
      );
    });

    it("should throw RateAlreadyEndedException when addon rate is already ended", async () => {
      databaseService.addonRate.findUnique.mockResolvedValue({
        id: "addon-1",
        effectiveUntil: new Date("2025-01-01"),
      });

      await expect(service.endAddonRate("addon-1")).rejects.toBeInstanceOf(
        RateAlreadyEndedException,
      );
    });
  });
});
