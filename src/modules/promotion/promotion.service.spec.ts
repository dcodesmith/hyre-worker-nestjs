import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TIMEZONE } from "../../config/constants";
import { createActivePromotion } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import {
  PromotionCarNotFoundException,
  PromotionCreateFailedException,
  PromotionFetchFailedException,
  PromotionNotFoundException,
  PromotionOverlapException,
  PromotionUpdateFailedException,
  PromotionValidationException,
} from "./promotion.error";
import { PromotionService } from "./promotion.service";

describe("PromotionService — pure helpers", () => {
  describe("toPromotionWindowExclusive", () => {
    it("converts inclusive calendar dates into start-inclusive / end-exclusive instants in Lagos", () => {
      const window = PromotionService.toPromotionWindowExclusive({
        startDate: "2026-04-11",
        endDateInclusive: "2026-04-14",
        timeZone: TIMEZONE,
      });

      expect(window.startDate.toISOString()).toBe(
        fromZonedTime("2026-04-11T00:00:00", TIMEZONE).toISOString(),
      );
      expect(window.endDate.toISOString()).toBe(
        fromZonedTime("2026-04-15T00:00:00", TIMEZONE).toISOString(),
      );
    });

    it("defaults to TIMEZONE when timeZone is not provided", () => {
      const explicit = PromotionService.toPromotionWindowExclusive({
        startDate: "2026-04-11",
        endDateInclusive: "2026-04-11",
        timeZone: TIMEZONE,
      });
      const defaulted = PromotionService.toPromotionWindowExclusive({
        startDate: "2026-04-11",
        endDateInclusive: "2026-04-11",
      });

      expect(defaulted.startDate.toISOString()).toBe(explicit.startDate.toISOString());
      expect(defaulted.endDate.toISOString()).toBe(explicit.endDate.toISOString());
    });

    it("supports a single-day promotion (start == endInclusive) by pushing end forward by one day", () => {
      const window = PromotionService.toPromotionWindowExclusive({
        startDate: "2026-04-11",
        endDateInclusive: "2026-04-11",
        timeZone: TIMEZONE,
      });

      expect(window.endDate.getTime() - window.startDate.getTime()).toBe(24 * 60 * 60 * 1000);
    });

    it("handles month boundaries when incrementing the calendar day", () => {
      const window = PromotionService.toPromotionWindowExclusive({
        startDate: "2026-01-30",
        endDateInclusive: "2026-01-31",
        timeZone: TIMEZONE,
      });

      expect(window.endDate.toISOString()).toBe(
        fromZonedTime("2026-02-01T00:00:00", TIMEZONE).toISOString(),
      );
    });

    it("throws validation errors for malformed dates", () => {
      expect(() =>
        PromotionService.toPromotionWindowExclusive({
          startDate: "not-a-date",
          endDateInclusive: "2026-04-11",
        }),
      ).toThrow(PromotionValidationException);
      expect(() =>
        PromotionService.toPromotionWindowExclusive({
          startDate: "2026-04-11",
          endDateInclusive: "2026/04/11",
        }),
      ).toThrow(PromotionValidationException);
    });

    it("throws when endDateInclusive is before startDate", () => {
      expect(() =>
        PromotionService.toPromotionWindowExclusive({
          startDate: "2026-04-15",
          endDateInclusive: "2026-04-14",
          timeZone: TIMEZONE,
        }),
      ).toThrow(PromotionValidationException);
    });
  });

  describe("resolveBestPromotionForInterval", () => {
    const carId = "car-123";
    const baseAmount = 50_000;

    it("returns null when no promotions overlap", () => {
      const chosen = PromotionService.resolveBestPromotionForInterval({
        promotions: [
          createActivePromotion({
            id: "p1",
            discountValue: 20,
            startDate: "2026-04-01T00:00:00Z",
            endDate: "2026-04-05T00:00:00Z",
            carId,
          }),
        ],
        carId,
        intervalStart: new Date("2026-05-01T00:00:00Z"),
        intervalEndExclusive: new Date("2026-05-02T00:00:00Z"),
        baseAmount,
      });

      expect(chosen).toBeNull();
    });

    it("prefers car-specific promotions over fleet-wide even with larger fleet discounts", () => {
      const chosen = PromotionService.resolveBestPromotionForInterval({
        promotions: [
          createActivePromotion({
            id: "fleet",
            carId: null,
            discountValue: 45,
            startDate: "2026-04-11T00:00:00.000Z",
            endDate: "2026-04-15T00:00:00.000Z",
          }),
          createActivePromotion({
            id: "car-specific",
            carId,
            discountValue: 10,
            startDate: "2026-04-11T00:00:00.000Z",
            endDate: "2026-04-15T00:00:00.000Z",
          }),
        ],
        carId,
        intervalStart: new Date("2026-04-12T00:00:00.000Z"),
        intervalEndExclusive: new Date("2026-04-13T00:00:00.000Z"),
        baseAmount,
      });

      expect(chosen?.id).toBe("car-specific");
    });

    it("falls back to fleet-wide when no car-specific promotion overlaps", () => {
      const chosen = PromotionService.resolveBestPromotionForInterval({
        promotions: [
          createActivePromotion({
            id: "fleet",
            carId: null,
            discountValue: 25,
            startDate: "2026-04-11T00:00:00.000Z",
            endDate: "2026-04-15T00:00:00.000Z",
          }),
        ],
        carId,
        intervalStart: new Date("2026-04-12T00:00:00.000Z"),
        intervalEndExclusive: new Date("2026-04-13T00:00:00.000Z"),
        baseAmount,
      });

      expect(chosen?.id).toBe("fleet");
    });

    it("chooses the highest-discount promotion among same-scope candidates", () => {
      const chosen = PromotionService.resolveBestPromotionForInterval({
        promotions: [
          createActivePromotion({
            id: "small",
            carId,
            discountValue: 10,
            startDate: "2026-04-11T00:00:00.000Z",
            endDate: "2026-04-15T00:00:00.000Z",
          }),
          createActivePromotion({
            id: "big",
            carId,
            discountValue: 25,
            startDate: "2026-04-11T00:00:00.000Z",
            endDate: "2026-04-15T00:00:00.000Z",
          }),
        ],
        carId,
        intervalStart: new Date("2026-04-12T00:00:00.000Z"),
        intervalEndExclusive: new Date("2026-04-13T00:00:00.000Z"),
        baseAmount,
      });

      expect(chosen?.id).toBe("big");
    });

    it("breaks discount ties on createdAt (newest wins)", () => {
      const chosen = PromotionService.resolveBestPromotionForInterval({
        promotions: [
          createActivePromotion({
            id: "older",
            carId,
            discountValue: 15,
            startDate: "2026-04-11T00:00:00.000Z",
            endDate: "2026-04-15T00:00:00.000Z",
            createdAt: "2026-04-01T00:00:00.000Z",
          }),
          createActivePromotion({
            id: "newer",
            carId,
            discountValue: 15,
            startDate: "2026-04-11T00:00:00.000Z",
            endDate: "2026-04-15T00:00:00.000Z",
            createdAt: "2026-04-10T00:00:00.000Z",
          }),
        ],
        carId,
        intervalStart: new Date("2026-04-12T00:00:00.000Z"),
        intervalEndExclusive: new Date("2026-04-13T00:00:00.000Z"),
        baseAmount,
      });

      expect(chosen?.id).toBe("newer");
    });

    it("treats touching boundaries as non-overlapping (end-exclusive semantics)", () => {
      const chosen = PromotionService.resolveBestPromotionForInterval({
        promotions: [
          createActivePromotion({
            id: "promo",
            carId,
            discountValue: 20,
            startDate: "2026-04-11T00:00:00.000Z",
            endDate: "2026-04-14T00:00:00.000Z",
          }),
        ],
        carId,
        intervalStart: new Date("2026-04-14T00:00:00.000Z"),
        intervalEndExclusive: new Date("2026-04-15T00:00:00.000Z"),
        baseAmount,
      });

      expect(chosen).toBeNull();
    });

    it("returns the first candidate when multiple tie and baseAmount is not provided", () => {
      const chosen = PromotionService.resolveBestPromotionForInterval({
        promotions: [
          createActivePromotion({
            id: "first",
            carId,
            discountValue: 10,
            startDate: "2026-04-11T00:00:00.000Z",
            endDate: "2026-04-15T00:00:00.000Z",
          }),
          createActivePromotion({
            id: "second",
            carId,
            discountValue: 15,
            startDate: "2026-04-11T00:00:00.000Z",
            endDate: "2026-04-15T00:00:00.000Z",
          }),
        ],
        carId,
        intervalStart: new Date("2026-04-12T00:00:00.000Z"),
        intervalEndExclusive: new Date("2026-04-13T00:00:00.000Z"),
      });

      expect(chosen?.id).toBe("first");
    });
  });

  describe("applyPromotionDiscount", () => {
    const promotion = createActivePromotion({
      id: "p",
      discountValue: 20,
      startDate: "2026-04-01",
      endDate: "2026-05-01",
    });

    it("applies the percentage discount", () => {
      expect(PromotionService.applyPromotionDiscount(50_000, promotion)).toBe(40_000);
    });

    it("floors the result at 1 so platform fee math never sees a zero rate", () => {
      const hundredPercent = createActivePromotion({
        id: "full",
        discountValue: 50,
        startDate: "2026-04-01",
        endDate: "2026-05-01",
      });
      expect(PromotionService.applyPromotionDiscount(1, hundredPercent)).toBe(1);
    });

    it("handles fractional percentages via decimal.js", () => {
      const fractional = createActivePromotion({
        id: "frac",
        discountValue: "12.5",
        startDate: "2026-04-01",
        endDate: "2026-05-01",
      });
      expect(PromotionService.applyPromotionDiscount(1_000, fractional)).toBe(875);
    });
  });

  describe("getDiscountedCarRates", () => {
    it("applies the discount to every rate field", () => {
      const promotion = createActivePromotion({
        id: "p",
        discountValue: 10,
        startDate: "2026-04-01",
        endDate: "2026-05-01",
      });

      expect(
        PromotionService.getDiscountedCarRates(
          {
            dayRate: 50_000,
            nightRate: 30_000,
            hourlyRate: 5_000,
            fullDayRate: 80_000,
            airportPickupRate: 25_000,
          },
          promotion,
        ),
      ).toEqual({
        dayRate: 45_000,
        nightRate: 27_000,
        hourlyRate: 4_500,
        fullDayRate: 72_000,
        airportPickupRate: 22_500,
      });
    });
  });

  describe("getPromotionBadgeLabel", () => {
    it("returns NN% OFF for integer discounts", () => {
      expect(
        PromotionService.getPromotionBadgeLabel(
          createActivePromotion({
            id: "p",
            discountValue: 25,
            startDate: "2026-04-01",
            endDate: "2026-05-01",
          }),
        ),
      ).toBe("25% OFF");
    });
  });
});

describe("PromotionService — DB-backed", () => {
  let service: PromotionService;
  let databaseService: {
    $transaction: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
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
      $transaction: vi.fn(async (fn: (tx: typeof databaseService) => Promise<unknown>) =>
        fn(databaseService),
      ),
      $executeRaw: vi.fn().mockResolvedValue(undefined),
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
      providers: [
        PromotionService,
        { provide: DatabaseService, useValue: databaseService },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn().mockImplementation((_key: string, fallbackOrOptions?: unknown) => {
              if (typeof fallbackOrOptions === "string") {
                return fallbackOrOptions;
              }
              return TIMEZONE;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<PromotionService>(PromotionService);
  });

  describe("getActivePromotionForCar", () => {
    it("returns null when no promotions are found", async () => {
      databaseService.promotion.findMany.mockResolvedValue([]);

      const result = await service.getActivePromotionForCar("car-1", "owner-1");

      expect(result).toBeNull();
    });

    it("prefers car-specific promotions over fleet-wide ones", async () => {
      databaseService.promotion.findMany.mockResolvedValue([
        createActivePromotion({
          id: "fleet",
          carId: null,
          discountValue: 30,
          startDate: "2026-04-01T00:00:00Z",
          endDate: "2026-04-30T00:00:00Z",
        }),
        createActivePromotion({
          id: "car",
          carId: "car-1",
          discountValue: 10,
          startDate: "2026-04-01T00:00:00Z",
          endDate: "2026-04-30T00:00:00Z",
        }),
      ]);

      const result = await service.getActivePromotionForCar(
        "car-1",
        "owner-1",
        new Date("2026-04-10T00:00:00Z"),
        50_000,
      );

      expect(result?.id).toBe("car");
    });

    it("wraps DB errors in PromotionFetchFailedException", async () => {
      databaseService.promotion.findMany.mockRejectedValue(new Error("boom"));

      await expect(service.getActivePromotionForCar("car-1", "owner-1")).rejects.toThrow(
        PromotionFetchFailedException,
      );
    });
  });

  describe("getActivePromotionsForCars", () => {
    it("returns an empty map when given no cars", async () => {
      const result = await service.getActivePromotionsForCars([]);

      expect(result.size).toBe(0);
      expect(databaseService.promotion.findMany).not.toHaveBeenCalled();
    });

    it("maps car-specific promotions to their car and falls back to fleet for uncovered cars", async () => {
      databaseService.promotion.findMany.mockResolvedValue([
        {
          ...createActivePromotion({
            id: "car-1-promo",
            carId: "car-1",
            discountValue: 15,
            startDate: "2026-04-01T00:00:00Z",
            endDate: "2026-04-30T00:00:00Z",
          }),
          ownerId: "owner-1",
        },
        {
          ...createActivePromotion({
            id: "fleet-promo",
            carId: null,
            discountValue: 20,
            startDate: "2026-04-01T00:00:00Z",
            endDate: "2026-04-30T00:00:00Z",
          }),
          ownerId: "owner-1",
        },
      ]);

      const result = await service.getActivePromotionsForCars(
        [
          { id: "car-1", ownerId: "owner-1" },
          { id: "car-2", ownerId: "owner-1" },
        ],
        new Date("2026-04-10T00:00:00Z"),
      );

      expect(result.get("car-1")?.id).toBe("car-1-promo");
      expect(result.get("car-2")?.id).toBe("fleet-promo");
    });

    it("per same-scope key keeps the highest discount, not merely the newest row", async () => {
      databaseService.promotion.findMany.mockResolvedValue([
        {
          ...createActivePromotion({
            id: "newer-low",
            carId: null,
            discountValue: 10,
            startDate: "2026-04-01T00:00:00Z",
            endDate: "2026-04-30T00:00:00Z",
            createdAt: "2026-04-05T12:00:00.000Z",
          }),
          ownerId: "owner-1",
        },
        {
          ...createActivePromotion({
            id: "older-high",
            carId: null,
            discountValue: 25,
            startDate: "2026-04-01T00:00:00Z",
            endDate: "2026-04-30T00:00:00Z",
            createdAt: "2026-04-01T00:00:00.000Z",
          }),
          ownerId: "owner-1",
        },
      ]);

      const result = await service.getActivePromotionsForCars(
        [{ id: "car-1", ownerId: "owner-1" }],
        new Date("2026-04-10T00:00:00Z"),
      );

      expect(result.get("car-1")?.id).toBe("older-high");
    });

    it("per same-scope key breaks discount ties with the more recently created promotion", async () => {
      databaseService.promotion.findMany.mockResolvedValue([
        {
          ...createActivePromotion({
            id: "older-tie",
            carId: "car-1",
            discountValue: 20,
            startDate: "2026-04-01T00:00:00Z",
            endDate: "2026-04-30T00:00:00Z",
            createdAt: "2026-04-01T00:00:00.000Z",
          }),
          ownerId: "owner-1",
        },
        {
          ...createActivePromotion({
            id: "newer-tie",
            carId: "car-1",
            discountValue: 20,
            startDate: "2026-04-01T00:00:00Z",
            endDate: "2026-04-30T00:00:00Z",
            createdAt: "2026-04-10T00:00:00.000Z",
          }),
          ownerId: "owner-1",
        },
      ]);

      const result = await service.getActivePromotionsForCars(
        [{ id: "car-1", ownerId: "owner-1" }],
        new Date("2026-04-10T00:00:00Z"),
      );

      expect(result.get("car-1")?.id).toBe("newer-tie");
    });

    it("ignores promotions from other owners even if carId matches", async () => {
      databaseService.promotion.findMany.mockResolvedValue([
        {
          ...createActivePromotion({
            id: "other-owner-promo",
            carId: "car-1",
            discountValue: 50,
            startDate: "2026-04-01T00:00:00Z",
            endDate: "2026-04-30T00:00:00Z",
          }),
          ownerId: "other-owner",
        },
      ]);

      const result = await service.getActivePromotionsForCars([
        { id: "car-1", ownerId: "owner-1" },
      ]);

      expect(result.get("car-1")).toBeUndefined();
    });
  });

  describe("getOverlappingPromotionsForCar", () => {
    it("returns an empty array for zero-length intervals without hitting the DB", async () => {
      const now = new Date("2026-04-10T00:00:00Z");
      const result = await service.getOverlappingPromotionsForCar("car-1", "owner-1", now, now);

      expect(result).toEqual([]);
      expect(databaseService.promotion.findMany).not.toHaveBeenCalled();
    });

    it("returns an empty array when endExclusive is before start", async () => {
      const start = new Date("2026-04-10T00:00:00Z");
      const end = new Date("2026-04-09T00:00:00Z");
      const result = await service.getOverlappingPromotionsForCar("car-1", "owner-1", start, end);

      expect(result).toEqual([]);
    });

    it("queries the database with half-open interval semantics", async () => {
      databaseService.promotion.findMany.mockResolvedValue([]);
      const start = new Date("2026-04-10T00:00:00Z");
      const end = new Date("2026-04-12T00:00:00Z");

      await service.getOverlappingPromotionsForCar("car-1", "owner-1", start, end);

      expect(databaseService.promotion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            ownerId: "owner-1",
            isActive: true,
            startDate: { lt: end },
            endDate: { gt: start },
            OR: [{ carId: "car-1" }, { carId: null }],
          }),
        }),
      );
    });
  });

  describe("createPromotion", () => {
    const validInput = {
      ownerId: "owner-1",
      carId: "car-1",
      name: "Easter",
      discountValue: 20,
      startDate: "2026-04-10",
      endDate: "2026-04-15",
    };

    beforeEach(() => {
      databaseService.car.findFirst.mockResolvedValue({ id: "car-1" });
      databaseService.promotion.findFirst.mockResolvedValue(null);
      databaseService.promotion.create.mockImplementation(async ({ data }: { data: unknown }) => ({
        id: "new-promo",
        ...(data as object),
      }));
    });

    it("creates a car-specific promotion", async () => {
      const result = await service.createPromotion(validInput);

      expect(result.id).toBe("new-promo");
      expect(databaseService.car.findFirst).toHaveBeenCalledWith({
        where: { id: "car-1", ownerId: "owner-1" },
        select: { id: true },
      });
    });

    it("skips the car ownership check when the promotion is fleet-wide", async () => {
      await service.createPromotion({ ...validInput, carId: null });

      expect(databaseService.car.findFirst).not.toHaveBeenCalled();
    });

    it("rejects discounts below the minimum", async () => {
      await expect(service.createPromotion({ ...validInput, discountValue: 0 })).rejects.toThrow(
        PromotionValidationException,
      );
    });

    it("rejects discounts above the maximum", async () => {
      await expect(service.createPromotion({ ...validInput, discountValue: 60 })).rejects.toThrow(
        PromotionValidationException,
      );
    });

    it("rejects end date that precedes start date", async () => {
      await expect(
        service.createPromotion({
          ...validInput,
          startDate: "2026-04-15",
          endDate: "2026-04-14",
        }),
      ).rejects.toThrow(PromotionValidationException);
    });

    it("rejects when the target car is not in the owner's fleet", async () => {
      databaseService.car.findFirst.mockResolvedValue(null);

      await expect(service.createPromotion(validInput)).rejects.toThrow(
        PromotionCarNotFoundException,
      );
    });

    it("rejects same-scope overlapping promotions", async () => {
      databaseService.promotion.findFirst.mockResolvedValue({ id: "existing" });

      await expect(service.createPromotion(validInput)).rejects.toThrow(PromotionOverlapException);
    });

    it("wraps unexpected DB errors in PromotionCreateFailedException", async () => {
      databaseService.promotion.create.mockRejectedValue(new Error("boom"));

      await expect(service.createPromotion(validInput)).rejects.toThrow(
        PromotionCreateFailedException,
      );
    });

    it("maps unique constraint failures to PromotionOverlapException", async () => {
      databaseService.promotion.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        }),
      );

      await expect(service.createPromotion(validInput)).rejects.toThrow(PromotionOverlapException);
    });
  });

  describe("deactivatePromotion", () => {
    it("soft-disables a promotion owned by the caller", async () => {
      databaseService.promotion.findFirst.mockResolvedValue({ id: "promo-1" });
      databaseService.promotion.update.mockResolvedValue({ id: "promo-1", isActive: false });

      const result = await service.deactivatePromotion("promo-1", "owner-1");

      expect(result.isActive).toBe(false);
      expect(databaseService.promotion.update).toHaveBeenCalledWith({
        where: { id: "promo-1" },
        data: { isActive: false },
      });
    });

    it("throws PromotionNotFoundException when the promotion is not owned by the caller", async () => {
      databaseService.promotion.findFirst.mockResolvedValue(null);

      await expect(service.deactivatePromotion("promo-1", "owner-1")).rejects.toThrow(
        PromotionNotFoundException,
      );
      expect(databaseService.promotion.update).not.toHaveBeenCalled();
    });

    it("wraps unexpected DB errors in PromotionUpdateFailedException", async () => {
      databaseService.promotion.findFirst.mockResolvedValue({ id: "promo-1" });
      databaseService.promotion.update.mockRejectedValue(new Error("boom"));

      await expect(service.deactivatePromotion("promo-1", "owner-1")).rejects.toThrow(
        PromotionUpdateFailedException,
      );
    });
  });
});
