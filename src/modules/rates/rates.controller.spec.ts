import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { AuthService } from "../auth/auth.service";
import { RatesController } from "./rates.controller";
import { RatesService } from "./rates.service";
import { RatesAdminService } from "./rates-admin.service";

describe("RatesController", () => {
  let controller: RatesController;
  let ratesService: {
    getRates: ReturnType<typeof vi.fn>;
  };
  let adminService: {
    getAllRates: ReturnType<typeof vi.fn>;
    createPlatformFeeRate: ReturnType<typeof vi.fn>;
    createVatRate: ReturnType<typeof vi.fn>;
    createAddonRate: ReturnType<typeof vi.fn>;
    endAddonRate: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    ratesService = {
      getRates: vi.fn(),
    };

    adminService = {
      getAllRates: vi.fn(),
      createPlatformFeeRate: vi.fn(),
      createVatRate: vi.fn(),
      createAddonRate: vi.fn(),
      endAddonRate: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RatesController],
      providers: [
        { provide: RatesService, useValue: ratesService },
        { provide: RatesAdminService, useValue: adminService },
        {
          provide: AuthService,
          useValue: {
            isInitialized: true,
            auth: {
              api: { getSession: vi.fn().mockResolvedValue(null) },
            },
            getUserRoles: vi.fn().mockResolvedValue(["admin"]),
          },
        },
        Reflector,
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    controller = module.get<RatesController>(RatesController);
  });

  describe("getPublicRates", () => {
    it("should return only user-facing rates", async () => {
      ratesService.getRates.mockResolvedValue({
        platformCustomerServiceFeeRatePercent: new Decimal("10"),
        platformFleetOwnerCommissionRatePercent: new Decimal("5"),
        vatRatePercent: new Decimal("7.5"),
        securityDetailRate: new Decimal("5000"),
      });

      const result = await controller.getPublicRates();

      expect(result).toEqual({
        platformCustomerServiceFeeRatePercent: 10,
        vatRatePercent: 7.5,
        securityDetailRate: 5000,
      });
      expect(ratesService.getRates).toHaveBeenCalledOnce();
    });
  });

  describe("getAllRates", () => {
    it("should delegate to admin service", async () => {
      const mockResult = { platformFeeRates: [], taxRates: [], addonRates: [] };
      adminService.getAllRates.mockResolvedValue(mockResult);

      const result = await controller.getAllRates();

      expect(result).toEqual(mockResult);
      expect(adminService.getAllRates).toHaveBeenCalledOnce();
    });
  });

  describe("createPlatformFeeRate", () => {
    it("should delegate to admin service with dto", async () => {
      const dto = {
        feeType: "PLATFORM_SERVICE_FEE" as const,
        ratePercent: 10,
        effectiveSince: new Date(),
      };
      const mockResult = { id: "pf-1", ...dto };
      adminService.createPlatformFeeRate.mockResolvedValue(mockResult);

      const result = await controller.createPlatformFeeRate(dto);

      expect(result).toEqual(mockResult);
      expect(adminService.createPlatformFeeRate).toHaveBeenCalledWith(dto);
    });
  });

  describe("createVatRate", () => {
    it("should delegate to admin service with dto", async () => {
      const dto = { ratePercent: 7.5, effectiveSince: new Date() };
      const mockResult = { id: "vat-1", ...dto };
      adminService.createVatRate.mockResolvedValue(mockResult);

      const result = await controller.createVatRate(dto);

      expect(result).toEqual(mockResult);
      expect(adminService.createVatRate).toHaveBeenCalledWith(dto);
    });
  });

  describe("createAddonRate", () => {
    it("should delegate to admin service with dto", async () => {
      const dto = {
        addonType: "SECURITY_DETAIL" as const,
        rateAmount: 5000,
        effectiveSince: new Date(),
      };
      const mockResult = { id: "addon-1", ...dto };
      adminService.createAddonRate.mockResolvedValue(mockResult);

      const result = await controller.createAddonRate(dto);

      expect(result).toEqual(mockResult);
      expect(adminService.createAddonRate).toHaveBeenCalledWith(dto);
    });
  });

  describe("endAddonRate", () => {
    it("should delegate to admin service with rate id", async () => {
      const mockResult = { id: "addon-1", effectiveUntil: new Date() };
      adminService.endAddonRate.mockResolvedValue(mockResult);

      const result = await controller.endAddonRate("addon-1");

      expect(result).toEqual(mockResult);
      expect(adminService.endAddonRate).toHaveBeenCalledWith("addon-1");
    });
  });
});
