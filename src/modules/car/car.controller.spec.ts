import { Test, type TestingModule } from "@nestjs/testing";
import { BookingType, ServiceTier, VehicleType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CarController } from "./car.controller";
import { CarCategoriesService } from "./car-categories.service";
import { CarSearchService } from "./car-search.service";
import type { CarCategoriesResponseDto, PublicCarDto } from "./dto/car-categories.dto";
import type { CarSearchResponseDto, SearchCarDto } from "./dto/car-search.dto";

describe("CarController", () => {
  let controller: CarController;
  let carCategoriesService: CarCategoriesService;
  let carSearchService: CarSearchService;

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

  const createMockSearchCar = (overrides: Partial<SearchCarDto> = {}): SearchCarDto => ({
    id: `car-${Math.random().toString(36).slice(2, 9)}`,
    make: "Toyota",
    model: "Camry",
    year: 2022,
    color: "Black",
    dayRate: 50000,
    nightRate: 60000,
    fullDayRate: 100000,
    airportPickupRate: 30000,
    passengerCapacity: 4,
    pricingIncludesFuel: true,
    vehicleType: VehicleType.SEDAN,
    serviceTier: ServiceTier.STANDARD,
    images: [{ url: "https://example.com/car.jpg" }],
    owner: { username: "fleetowner1", name: "Fleet Owner" },
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CarController],
      providers: [
        {
          provide: CarCategoriesService,
          useValue: {
            getCategorizedCars: vi.fn(),
          },
        },
        {
          provide: CarSearchService,
          useValue: {
            searchCars: vi.fn(),
            getPublicCarById: vi.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<CarController>(CarController);
    carCategoriesService = module.get<CarCategoriesService>(CarCategoriesService);
    carSearchService = module.get<CarSearchService>(CarSearchService);
  });

  describe("getCarCategories", () => {
    it("returns categorized cars (GET /api/cars/categories)", async () => {
      const mockResponse: CarCategoriesResponseDto = {
        categories: [
          {
            name: "suvs",
            title: "SUV",
            cars: [
              createMockCar({ id: "suv-1", vehicleType: VehicleType.SUV }),
              createMockCar({ id: "suv-2", vehicleType: VehicleType.SUV }),
              createMockCar({ id: "suv-3", vehicleType: VehicleType.LUXURY_SUV }),
            ],
          },
        ],
        allCars: [],
        total: 3,
      };
      vi.mocked(carCategoriesService.getCategorizedCars).mockResolvedValueOnce(mockResponse);

      const result = await controller.getCarCategories({ limit: 50 });

      expect(result).toEqual(mockResponse);
      expect(carCategoriesService.getCategorizedCars).toHaveBeenCalledWith({ limit: 50 });
    });

    it("returns empty categories when no cars exist", async () => {
      const emptyResponse: CarCategoriesResponseDto = {
        categories: [],
        allCars: [],
        total: 0,
      };
      vi.mocked(carCategoriesService.getCategorizedCars).mockResolvedValueOnce(emptyResponse);

      const result = await controller.getCarCategories({ limit: 50 });

      expect(result.total).toBe(0);
      expect(result.categories).toEqual([]);
    });
  });

  describe("searchCars", () => {
    it("returns search results (GET /api/cars/search)", async () => {
      const mockResponse: CarSearchResponseDto = {
        cars: [
          createMockSearchCar({ id: "car-1", serviceTier: ServiceTier.LUXURY }),
          createMockSearchCar({ id: "car-2", serviceTier: ServiceTier.LUXURY }),
        ],
        filters: {
          serviceTier: ServiceTier.LUXURY,
          vehicleType: null,
          bookingType: null,
        },
        pagination: {
          page: 1,
          limit: 12,
          total: 2,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      };
      vi.mocked(carSearchService.searchCars).mockResolvedValueOnce(mockResponse);

      const result = await controller.searchCars({
        serviceTier: ServiceTier.LUXURY,
        page: 1,
        limit: 12,
      });

      expect(result).toEqual(mockResponse);
      expect(carSearchService.searchCars).toHaveBeenCalledWith({
        serviceTier: ServiceTier.LUXURY,
        page: 1,
        limit: 12,
      });
    });

    it("returns empty results when no cars match", async () => {
      const emptyResponse: CarSearchResponseDto = {
        cars: [],
        filters: {
          serviceTier: null,
          vehicleType: null,
          bookingType: null,
        },
        pagination: {
          page: 1,
          limit: 12,
          total: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      };
      vi.mocked(carSearchService.searchCars).mockResolvedValueOnce(emptyResponse);

      const result = await controller.searchCars({ page: 1, limit: 12 });

      expect(result.cars).toEqual([]);
      expect(result.pagination.total).toBe(0);
    });

    it("passes all query parameters to service", async () => {
      const mockResponse: CarSearchResponseDto = {
        cars: [],
        filters: {
          serviceTier: ServiceTier.EXECUTIVE,
          vehicleType: VehicleType.SUV,
          bookingType: BookingType.DAY,
        },
        pagination: {
          page: 2,
          limit: 10,
          total: 15,
          totalPages: 2,
          hasNextPage: false,
          hasPreviousPage: true,
        },
      };
      vi.mocked(carSearchService.searchCars).mockResolvedValueOnce(mockResponse);

      const query = {
        q: "Toyota",
        serviceTier: ServiceTier.EXECUTIVE,
        vehicleType: VehicleType.SUV,
        color: "Black",
        make: "Toyota",
        from: new Date("2024-03-01"),
        to: new Date("2024-03-02"),
        bookingType: BookingType.DAY,
        page: 2,
        limit: 10,
      };

      await controller.searchCars(query);

      expect(carSearchService.searchCars).toHaveBeenCalledWith(query);
    });
  });

  describe("getPublicCarById", () => {
    it("returns a public car by ID (GET /api/cars/:carId)", async () => {
      const mockCar = {
        ...createMockSearchCar({ id: "car-123" }),
        hourlyRate: 5000,
        fuelUpgradeRate: 10000,
      };
      vi.mocked(carSearchService.getPublicCarById).mockResolvedValueOnce(mockCar);

      const result = await controller.getPublicCarById("car-123");

      expect(result).toEqual(mockCar);
      expect(carSearchService.getPublicCarById).toHaveBeenCalledWith("car-123");
    });
  });
});
