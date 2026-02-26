import { Test, type TestingModule } from "@nestjs/testing";
import { BookingType, ServiceTier, VehicleType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { CarFetchFailedException, CarNotFoundException } from "./car.error";
import { CarSearchService } from "./car-search.service";
import type { SearchCarDto } from "./dto/car-search.dto";
import { mapQueryToFilters } from "./dto/car-search.dto";

describe("CarSearchService", () => {
  let service: CarSearchService;

  const databaseServiceMock = {
    car: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
    booking: {
      findMany: vi.fn(),
    },
  };

  const createMockCar = (overrides: Partial<SearchCarDto> = {}): SearchCarDto => ({
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
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [CarSearchService, { provide: DatabaseService, useValue: databaseServiceMock }],
    }).compile();

    service = module.get<CarSearchService>(CarSearchService);
  });

  describe("mapQueryToFilters", () => {
    it("maps exact vehicle type match", () => {
      expect(mapQueryToFilters("SUV")).toEqual({ vehicleType: VehicleType.SUV });
      expect(mapQueryToFilters("sedan")).toEqual({ vehicleType: VehicleType.SEDAN });
    });

    it("maps exact service tier match", () => {
      expect(mapQueryToFilters("Luxury")).toEqual({ serviceTier: ServiceTier.LUXURY });
      expect(mapQueryToFilters("EXECUTIVE")).toEqual({ serviceTier: ServiceTier.EXECUTIVE });
    });

    it("extracts remaining query after mapping", () => {
      const result = mapQueryToFilters("Toyota Luxury");
      expect(result.serviceTier).toBe(ServiceTier.LUXURY);
      expect(result.remainingQuery).toBe("Toyota");
    });

    it("returns query as remainingQuery when no mapping", () => {
      expect(mapQueryToFilters("Mercedes")).toEqual({ remainingQuery: "Mercedes" });
      expect(mapQueryToFilters("BMW X5")).toEqual({ remainingQuery: "BMW X5" });
    });

    it("handles case insensitive matching", () => {
      expect(mapQueryToFilters("suv")).toEqual({ vehicleType: VehicleType.SUV });
      expect(mapQueryToFilters("LUXURY")).toEqual({ serviceTier: ServiceTier.LUXURY });
    });

    it("returns remainingQuery for short queries (< 3 chars)", () => {
      expect(mapQueryToFilters("AB")).toEqual({ remainingQuery: "AB" });
    });
  });

  describe("searchCars", () => {
    it("returns empty results when no cars exist", async () => {
      databaseServiceMock.car.count.mockResolvedValueOnce(0);
      databaseServiceMock.car.findMany.mockResolvedValueOnce([]);

      const result = await service.searchCars({ page: 1, limit: 12 });

      expect(result.cars).toEqual([]);
      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
    });

    it("returns cars matching serviceTier filter", async () => {
      const luxuryCars = [
        createMockCar({ id: "lux-1", serviceTier: ServiceTier.LUXURY }),
        createMockCar({ id: "lux-2", serviceTier: ServiceTier.LUXURY }),
      ];
      databaseServiceMock.car.count.mockResolvedValueOnce(2);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(luxuryCars);

      const result = await service.searchCars({
        serviceTier: ServiceTier.LUXURY,
        page: 1,
        limit: 12,
      });

      expect(result.cars).toHaveLength(2);
      expect(result.filters.serviceTier).toBe(ServiceTier.LUXURY);
    });

    it("returns cars matching vehicleType filter", async () => {
      const suvCars = [
        createMockCar({ id: "suv-1", vehicleType: VehicleType.SUV }),
        createMockCar({ id: "suv-2", vehicleType: VehicleType.SUV }),
      ];
      databaseServiceMock.car.count.mockResolvedValueOnce(2);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(suvCars);

      const result = await service.searchCars({
        vehicleType: VehicleType.SUV,
        page: 1,
        limit: 12,
      });

      expect(result.cars).toHaveLength(2);
      expect(result.filters.vehicleType).toBe(VehicleType.SUV);
    });

    it("maps free-text query to filters", async () => {
      const luxuryCars = [createMockCar({ id: "lux-1", serviceTier: ServiceTier.LUXURY })];
      databaseServiceMock.car.count.mockResolvedValueOnce(1);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(luxuryCars);

      const result = await service.searchCars({
        q: "Luxury",
        page: 1,
        limit: 12,
      });

      expect(result.filters.serviceTier).toBe(ServiceTier.LUXURY);
    });

    it("searches by make/model when query doesn't match filters", async () => {
      const mercedesCars = [createMockCar({ id: "merc-1", make: "Mercedes" })];
      databaseServiceMock.car.count.mockResolvedValueOnce(1);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(mercedesCars);

      const result = await service.searchCars({
        q: "Mercedes",
        page: 1,
        limit: 12,
      });

      expect(result.cars).toHaveLength(1);
      expect(result.filters.serviceTier).toBeNull();
      expect(result.filters.vehicleType).toBeNull();
    });

    it("filters by color", async () => {
      const blackCars = [createMockCar({ id: "black-1", color: "Black" })];
      databaseServiceMock.car.count.mockResolvedValueOnce(1);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(blackCars);

      const result = await service.searchCars({
        color: "Black",
        page: 1,
        limit: 12,
      });

      expect(result.cars).toHaveLength(1);
    });

    it("paginates results correctly", async () => {
      const cars = Array.from({ length: 25 }, (_, i) => createMockCar({ id: `car-${i}` }));
      databaseServiceMock.car.count.mockResolvedValueOnce(25);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(cars.slice(0, 12));

      const result = await service.searchCars({ page: 1, limit: 12 });

      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(12);
      expect(result.pagination.total).toBe(25);
      expect(result.pagination.totalPages).toBe(3);
      expect(result.pagination.hasNextPage).toBe(true);
      expect(result.pagination.hasPreviousPage).toBe(false);
    });

    it("returns hasPreviousPage true for page 2", async () => {
      const cars = [createMockCar({ id: "car-1" })];
      databaseServiceMock.car.count.mockResolvedValueOnce(15);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(cars);

      const result = await service.searchCars({ page: 2, limit: 12 });

      expect(result.pagination.hasPreviousPage).toBe(true);
    });

    it("excludes unavailable fleet owners when date provided", async () => {
      const unavailableOwners = [{ id: "owner-busy" }];
      databaseServiceMock.user.findMany.mockResolvedValueOnce(unavailableOwners);
      databaseServiceMock.car.count.mockResolvedValueOnce(5);
      databaseServiceMock.car.findMany.mockResolvedValueOnce([createMockCar({ id: "car-1" })]);

      await service.searchCars({
        from: new Date("2024-03-01"),
        page: 1,
        limit: 12,
      });

      expect(databaseServiceMock.user.findMany).toHaveBeenCalled();
      expect(databaseServiceMock.car.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                ownerId: { notIn: ["owner-busy"] },
              }),
            ]),
          }),
        }),
      );
    });

    it("filters by availability when booking params provided", async () => {
      const cars = [createMockCar({ id: "car-available" })];

      databaseServiceMock.user.findMany.mockResolvedValueOnce([]);
      databaseServiceMock.car.count.mockResolvedValueOnce(1);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(cars);

      const result = await service.searchCars({
        from: new Date("2024-03-01"),
        to: new Date("2024-03-02"),
        bookingType: BookingType.NIGHT,
        page: 1,
        limit: 12,
      });

      expect(result.cars).toHaveLength(1);
      expect(result.cars[0].id).toBe("car-available");
      expect(databaseServiceMock.car.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                bookings: expect.objectContaining({
                  none: expect.objectContaining({
                    status: { in: ["CONFIRMED", "ACTIVE"] },
                  }),
                }),
              }),
            ]),
          }),
        }),
      );
    });

    it("sets bookingType in filters when provided", async () => {
      databaseServiceMock.user.findMany.mockResolvedValueOnce([]);
      databaseServiceMock.car.count.mockResolvedValueOnce(0);
      databaseServiceMock.car.findMany.mockResolvedValueOnce([]);

      const result = await service.searchCars({
        from: new Date("2024-03-01"),
        to: new Date("2024-03-02"),
        bookingType: BookingType.AIRPORT_PICKUP,
        page: 1,
        limit: 12,
      });

      expect(result.filters.bookingType).toBe(BookingType.AIRPORT_PICKUP);
    });

    it("throws CarFetchFailedException when database query fails", async () => {
      databaseServiceMock.car.count.mockRejectedValueOnce(new Error("Database error"));

      await expect(service.searchCars({ page: 1, limit: 12 })).rejects.toThrow(
        CarFetchFailedException,
      );
    });

    it("combines multiple filters", async () => {
      const cars = [
        createMockCar({
          id: "match",
          make: "Toyota",
          serviceTier: ServiceTier.EXECUTIVE,
          vehicleType: VehicleType.SUV,
        }),
      ];
      databaseServiceMock.car.count.mockResolvedValueOnce(1);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(cars);

      const result = await service.searchCars({
        serviceTier: ServiceTier.EXECUTIVE,
        vehicleType: VehicleType.SUV,
        make: "Toyota",
        page: 1,
        limit: 12,
      });

      expect(result.cars).toHaveLength(1);
      expect(result.filters.serviceTier).toBe(ServiceTier.EXECUTIVE);
      expect(result.filters.vehicleType).toBe(VehicleType.SUV);
    });
  });

  describe("getPublicCarById", () => {
    it("returns a car when found", async () => {
      const mockCar = {
        ...createMockCar({ id: "car-123" }),
        hourlyRate: 5000,
        fuelUpgradeRate: 10000,
      };
      databaseServiceMock.car.findFirst.mockResolvedValueOnce(mockCar);

      const result = await service.getPublicCarById("car-123");

      expect(result).toEqual(mockCar);
      expect(databaseServiceMock.car.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "car-123",
          }),
        }),
      );
    });

    it("throws CarNotFoundException when car not found", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce(null);

      await expect(service.getPublicCarById("nonexistent-id")).rejects.toThrow(
        CarNotFoundException,
      );
    });

    it("throws CarFetchFailedException on database error", async () => {
      databaseServiceMock.car.findFirst.mockRejectedValueOnce(new Error("Database error"));

      await expect(service.getPublicCarById("car-123")).rejects.toThrow(CarFetchFailedException);
    });
  });
});
