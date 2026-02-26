import { Test, type TestingModule } from "@nestjs/testing";
import { ServiceTier, VehicleType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { CarFetchFailedException } from "./car.error";
import { CarCategoriesService } from "./car-categories.service";
import type { PublicCarDto } from "./dto/car-categories.dto";

describe("CarCategoriesService", () => {
  let service: CarCategoriesService;

  const databaseServiceMock = {
    car: {
      findMany: vi.fn(),
    },
  };

  const createMockCar = (overrides: Partial<PublicCarDto> = {}): PublicCarDto => ({
    id: `car-${Math.random().toString(36).slice(2, 9)}`,
    make: "Toyota",
    model: "Camry",
    year: 2022,
    dayRate: 50000,
    passengerCapacity: 4,
    pricingIncludesFuel: true,
    vehicleType: VehicleType.SEDAN,
    serviceTier: ServiceTier.STANDARD,
    images: [{ url: "https://example.com/car.jpg" }],
    ...overrides,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CarCategoriesService,
        { provide: DatabaseService, useValue: databaseServiceMock },
      ],
    }).compile();

    service = module.get<CarCategoriesService>(CarCategoriesService);
  });

  const findCategory = (
    categories: { name: string; title: string; cars: PublicCarDto[] }[],
    name: string,
  ) => categories.find((c) => c.name === name);

  describe("getCategorizedCars", () => {
    it("returns empty categories when no cars exist", async () => {
      databaseServiceMock.car.findMany.mockResolvedValueOnce([]);

      const result = await service.getCategorizedCars({ limit: 50 });

      expect(result).toEqual({
        categories: [],
        allCars: [],
        total: 0,
      });
    });

    it("categorizes SUVs correctly with name and title", async () => {
      const suvCars = [
        createMockCar({ id: "suv-1", vehicleType: VehicleType.SUV }),
        createMockCar({ id: "suv-2", vehicleType: VehicleType.SUV }),
        createMockCar({ id: "suv-3", vehicleType: VehicleType.LUXURY_SUV }),
      ];
      databaseServiceMock.car.findMany.mockResolvedValueOnce(suvCars);

      const result = await service.getCategorizedCars({ limit: 50 });

      const suvsCategory = findCategory(result.categories, "suvs");
      expect(suvsCategory).toBeDefined();
      expect(suvsCategory?.title).toBe("SUV");
      expect(suvsCategory?.cars).toHaveLength(3);
      expect(suvsCategory?.cars.map((c) => c.id)).toEqual(["suv-1", "suv-2", "suv-3"]);
    });

    it("categorizes sedans correctly", async () => {
      const sedanCars = [
        createMockCar({ id: "sedan-1", vehicleType: VehicleType.SEDAN }),
        createMockCar({ id: "sedan-2", vehicleType: VehicleType.SEDAN }),
        createMockCar({ id: "sedan-3", vehicleType: VehicleType.LUXURY_SEDAN }),
      ];
      databaseServiceMock.car.findMany.mockResolvedValueOnce(sedanCars);

      const result = await service.getCategorizedCars({ limit: 50 });

      const sedansCategory = findCategory(result.categories, "sedans");
      expect(sedansCategory).toBeDefined();
      expect(sedansCategory?.title).toBe("Sedans");
      expect(sedansCategory?.cars).toHaveLength(3);
    });

    it("categorizes luxury cars by serviceTier", async () => {
      const luxuryCars = [
        createMockCar({ id: "lux-1", serviceTier: ServiceTier.LUXURY }),
        createMockCar({ id: "lux-2", serviceTier: ServiceTier.LUXURY }),
        createMockCar({ id: "lux-3", serviceTier: ServiceTier.ULTRA_LUXURY }),
      ];
      databaseServiceMock.car.findMany.mockResolvedValueOnce(luxuryCars);

      const result = await service.getCategorizedCars({ limit: 50 });

      const luxuryCategory = findCategory(result.categories, "luxury");
      expect(luxuryCategory).toBeDefined();
      expect(luxuryCategory?.title).toBe("Luxury");
      expect(luxuryCategory?.cars).toHaveLength(3);
    });

    it("categorizes executive cars by serviceTier", async () => {
      const execCars = [
        createMockCar({ id: "exec-1", serviceTier: ServiceTier.EXECUTIVE }),
        createMockCar({ id: "exec-2", serviceTier: ServiceTier.EXECUTIVE }),
        createMockCar({ id: "exec-3", serviceTier: ServiceTier.EXECUTIVE }),
      ];
      databaseServiceMock.car.findMany.mockResolvedValueOnce(execCars);

      const result = await service.getCategorizedCars({ limit: 50 });

      const execCategory = findCategory(result.categories, "executive");
      expect(execCategory).toBeDefined();
      expect(execCategory?.title).toBe("Executive");
      expect(execCategory?.cars).toHaveLength(3);
    });

    it("categorizes budget cars by STANDARD serviceTier", async () => {
      const budgetCars = [
        createMockCar({ id: "budget-1", serviceTier: ServiceTier.STANDARD }),
        createMockCar({ id: "budget-2", serviceTier: ServiceTier.STANDARD }),
        createMockCar({ id: "budget-3", serviceTier: ServiceTier.STANDARD }),
      ];
      databaseServiceMock.car.findMany.mockResolvedValueOnce(budgetCars);

      const result = await service.getCategorizedCars({ limit: 50 });

      const budgetCategory = findCategory(result.categories, "budget");
      expect(budgetCategory).toBeDefined();
      expect(budgetCategory?.title).toBe("Budget-friendly");
      expect(budgetCategory?.cars).toHaveLength(3);
    });

    it("categorizes popular cars by make (Toyota, Honda, Lexus)", async () => {
      const popularCars = [
        createMockCar({ id: "pop-1", make: "Toyota" }),
        createMockCar({ id: "pop-2", make: "Honda" }),
        createMockCar({ id: "pop-3", make: "Lexus" }),
      ];
      databaseServiceMock.car.findMany.mockResolvedValueOnce(popularCars);

      const result = await service.getCategorizedCars({ limit: 50 });

      const popularCategory = findCategory(result.categories, "popular");
      expect(popularCategory).toBeDefined();
      expect(popularCategory?.title).toBe("Popular");
      expect(popularCategory?.cars).toHaveLength(3);
    });

    it("handles case-insensitive make matching for popular category", async () => {
      const popularCars = [
        createMockCar({ id: "pop-1", make: "TOYOTA" }),
        createMockCar({ id: "pop-2", make: "honda" }),
        createMockCar({ id: "pop-3", make: "LeXuS" }),
      ];
      databaseServiceMock.car.findMany.mockResolvedValueOnce(popularCars);

      const result = await service.getCategorizedCars({ limit: 50 });

      const popularCategory = findCategory(result.categories, "popular");
      expect(popularCategory?.cars).toHaveLength(3);
    });

    it("excludes categories with less than 3 cars", async () => {
      const cars = [
        createMockCar({ id: "suv-1", vehicleType: VehicleType.SUV }),
        createMockCar({ id: "suv-2", vehicleType: VehicleType.SUV }),
        // Only 2 SUVs - should not show in categories
      ];
      databaseServiceMock.car.findMany.mockResolvedValueOnce(cars);

      const result = await service.getCategorizedCars({ limit: 50 });

      const suvsCategory = findCategory(result.categories, "suvs");
      expect(suvsCategory).toBeUndefined();
      expect(result.allCars).toHaveLength(2);
    });

    it("allows cars to appear in multiple categories", async () => {
      // Lexus SUVs with LUXURY tier should appear in: suvs, luxury, popular
      const cars = [
        createMockCar({
          id: "lexus-suv-1",
          make: "Lexus",
          vehicleType: VehicleType.LUXURY_SUV,
          serviceTier: ServiceTier.LUXURY,
        }),
        createMockCar({
          id: "lexus-suv-2",
          make: "Lexus",
          vehicleType: VehicleType.SUV,
          serviceTier: ServiceTier.LUXURY,
        }),
        createMockCar({
          id: "lexus-suv-3",
          make: "Lexus",
          vehicleType: VehicleType.SUV,
          serviceTier: ServiceTier.LUXURY,
        }),
      ];
      databaseServiceMock.car.findMany.mockResolvedValueOnce(cars);

      const result = await service.getCategorizedCars({ limit: 50 });

      expect(findCategory(result.categories, "suvs")?.cars).toHaveLength(3);
      expect(findCategory(result.categories, "luxury")?.cars).toHaveLength(3);
      expect(findCategory(result.categories, "popular")?.cars).toHaveLength(3);
    });

    it("respects the limit parameter", async () => {
      databaseServiceMock.car.findMany.mockResolvedValueOnce([]);

      await service.getCategorizedCars({ limit: 25 });

      expect(databaseServiceMock.car.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 25 }),
      );
    });

    it("returns total count and allCars", async () => {
      const cars = [
        createMockCar({ id: "car-1" }),
        createMockCar({ id: "car-2" }),
        createMockCar({ id: "car-3" }),
      ];
      databaseServiceMock.car.findMany.mockResolvedValueOnce(cars);

      const result = await service.getCategorizedCars({ limit: 50 });

      expect(result.total).toBe(3);
      expect(result.allCars).toHaveLength(3);
    });

    it("throws CarFetchFailedException when database query fails", async () => {
      databaseServiceMock.car.findMany.mockRejectedValueOnce(new Error("Database error"));

      await expect(service.getCategorizedCars({ limit: 50 })).rejects.toThrow(
        CarFetchFailedException,
      );
    });
  });
});
