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

  beforeEach(async () => {
    ratesService = {
      getRates: vi.fn(),
    };

    const adminService = {
      getAllRates: vi.fn(),
      createPlatformFeeRate: vi.fn(),
      createVatRate: vi.fn(),
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
      });

      const result = await controller.getPublicRates();

      expect(result).toEqual({
        platformCustomerServiceFeeRatePercent: 10,
        vatRatePercent: 7.5,
      });
      expect(ratesService.getRates).toHaveBeenCalledOnce();
    });
  });
});
