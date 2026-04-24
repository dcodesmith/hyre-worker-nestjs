import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { PromotionsService } from "./promotions.service";

describe("PromotionsService", () => {
  let service: PromotionsService;
  let databaseService: {
    promotion: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    car: {
      findFirst: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    databaseService = {
      promotion: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      car: {
        findFirst: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [PromotionsService, { provide: DatabaseService, useValue: databaseService }],
    }).compile();

    service = module.get<PromotionsService>(PromotionsService);
  });

  it("converts inclusive promotion dates to end-exclusive", () => {
    const result = service.toPromotionWindowExclusive({
      startDate: "2026-04-11",
      endDateInclusive: "2026-04-14",
      timeZone: "Africa/Lagos",
    });

    expect(result.startDate.toISOString()).toBe("2026-04-10T23:00:00.000Z");
    expect(result.endDate.toISOString()).toBe("2026-04-14T23:00:00.000Z");
  });

  it("prefers car-specific promotions over fleet-wide promotions", () => {
    const promotions = [
      {
        id: "fleet",
        name: "Fleet Promo",
        discountValue: new Decimal(25),
        startDate: new Date("2026-04-11T00:00:00.000Z"),
        endDate: new Date("2026-04-15T00:00:00.000Z"),
        carId: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: "car-specific",
        name: "Car Promo",
        discountValue: new Decimal(10),
        startDate: new Date("2026-04-11T00:00:00.000Z"),
        endDate: new Date("2026-04-15T00:00:00.000Z"),
        carId: "car-123",
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
      },
    ];

    const selected = service.resolveBestPromotionForInterval({
      promotions,
      carId: "car-123",
      intervalStart: new Date("2026-04-12T00:00:00.000Z"),
      intervalEndExclusive: new Date("2026-04-13T00:00:00.000Z"),
      baseAmount: new Decimal(50000),
    });

    expect(selected?.id).toBe("car-specific");
  });

  it("uses end-exclusive overlap semantics", () => {
    const promotions = [
      {
        id: "promo",
        name: "Promo",
        discountValue: new Decimal(20),
        startDate: new Date("2026-04-11T00:00:00.000Z"),
        endDate: new Date("2026-04-14T00:00:00.000Z"),
        carId: "car-123",
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
      },
    ];

    const selected = service.resolveBestPromotionForInterval({
      promotions,
      carId: "car-123",
      intervalStart: new Date("2026-04-14T00:00:00.000Z"),
      intervalEndExclusive: new Date("2026-04-15T00:00:00.000Z"),
      baseAmount: new Decimal(50000),
    });

    expect(selected).toBeNull();
  });

  it("blocks creation when overlapping same-scope promotion exists", async () => {
    databaseService.promotion.findFirst.mockResolvedValue({ id: "existing-promo" });

    await expect(
      service.createPromotion({
        ownerId: "owner-1",
        carId: null,
        discountValue: 10,
        startDate: new Date("2026-05-01T00:00:00.000Z"),
        endDate: new Date("2026-05-05T00:00:00.000Z"),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects create when car does not belong to owner", async () => {
    databaseService.car.findFirst.mockResolvedValue(null);

    await expect(
      service.createPromotion({
        ownerId: "owner-1",
        carId: "car-999",
        discountValue: 15,
        startDate: new Date("2026-05-01T00:00:00.000Z"),
        endDate: new Date("2026-05-05T00:00:00.000Z"),
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("deactivates promotion only within owner scope", async () => {
    databaseService.promotion.findFirst.mockResolvedValue({ id: "promo-1" });
    databaseService.promotion.update.mockResolvedValue({ id: "promo-1", isActive: false });

    const result = await service.deactivatePromotion("promo-1", "owner-1");

    expect(databaseService.promotion.update).toHaveBeenCalledWith({
      where: { id: "promo-1" },
      data: { isActive: false },
    });
    expect(result).toEqual({ id: "promo-1", isActive: false });
  });
});
