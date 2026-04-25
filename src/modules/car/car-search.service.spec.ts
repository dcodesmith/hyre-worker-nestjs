import { Test, type TestingModule } from "@nestjs/testing";
import {
  BookingStatus,
  BookingType,
  PaymentStatus,
  ServiceTier,
  VehicleType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { PromotionService } from "../promotion/promotion.service";
import { CarFetchFailedException, CarNotFoundException } from "./car.error";
import { CarPromotionEnrichmentService } from "./car-promotion.enrichment";
import { CarSearchService } from "./car-search.service";
import type { SearchCarDto } from "./dto/car-search.dto";
import { mapQueryToFilters } from "./dto/car-search.dto";

describe("CarSearchService", () => {
  let service: CarSearchService;
  let mockCarIdCounter = 0;

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
  const promotionServiceMock = {
    getActivePromotionsForCars: vi.fn(),
    getActivePromotionForCar: vi.fn(),
  };

  const createMockCar = (
    overrides: Partial<SearchCarDto & { ownerId: string }> = {},
  ): SearchCarDto & { ownerId: string } => ({
    id: `car-${mockCarIdCounter++}`,
    ownerId: "owner-1",
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
    promotion: null,
    ...overrides,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCarIdCounter = 0;
    databaseServiceMock.booking.findMany.mockResolvedValue([]);
    promotionServiceMock.getActivePromotionsForCars.mockResolvedValue(new Map());
    promotionServiceMock.getActivePromotionForCar.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CarSearchService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: PromotionService, useValue: promotionServiceMock },
        CarPromotionEnrichmentService,
      ],
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
      expect(promotionServiceMock.getActivePromotionsForCars).toHaveBeenCalledWith(
        [],
        expect.any(Date),
      );
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
                bookings: {
                  none: expect.objectContaining({
                    paymentStatus: PaymentStatus.PAID,
                    status: { in: [BookingStatus.CONFIRMED, BookingStatus.ACTIVE] },
                  }),
                },
              }),
            ]),
          }),
        }),
      );
    });

    it("applies default DAY pickup time availability filtering when pickupTime is omitted", async () => {
      databaseServiceMock.user.findMany.mockResolvedValueOnce([]);
      databaseServiceMock.car.count.mockResolvedValueOnce(0);
      databaseServiceMock.car.findMany.mockResolvedValueOnce([]);

      await service.searchCars({
        from: new Date("2024-03-10T00:00:00.000Z"),
        to: new Date("2024-03-10T00:00:00.000Z"),
        bookingType: BookingType.DAY,
        page: 1,
        limit: 12,
      });

      expect(databaseServiceMock.car.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                bookings: {
                  none: expect.objectContaining({
                    startDate: { lt: new Date("2024-03-10T21:00:00.000Z") },
                    endDate: { gt: new Date("2024-03-10T05:00:00.000Z") },
                  }),
                },
              }),
            ]),
          }),
        }),
      );
    });

    it("applies a valid overnight availability window for NIGHT when from equals to", async () => {
      databaseServiceMock.user.findMany.mockResolvedValueOnce([]);
      databaseServiceMock.car.count.mockResolvedValueOnce(0);
      databaseServiceMock.car.findMany.mockResolvedValueOnce([]);

      await service.searchCars({
        from: new Date("2024-03-10T00:00:00.000Z"),
        to: new Date("2024-03-10T00:00:00.000Z"),
        bookingType: BookingType.NIGHT,
        page: 1,
        limit: 12,
      });

      expect(databaseServiceMock.car.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                bookings: {
                  none: expect.objectContaining({
                    startDate: { lt: new Date("2024-03-11T07:00:00.000Z") },
                    endDate: { gt: new Date("2024-03-10T21:00:00.000Z") },
                  }),
                },
              }),
            ]),
          }),
        }),
      );
    });

    it("uses the same availability-aware where for count and list queries", async () => {
      databaseServiceMock.user.findMany.mockResolvedValueOnce([]);
      databaseServiceMock.car.count.mockResolvedValueOnce(7);
      databaseServiceMock.car.findMany.mockResolvedValueOnce([createMockCar({ id: "car-1" })]);

      await service.searchCars({
        from: new Date("2024-03-01"),
        to: new Date("2024-03-02"),
        bookingType: BookingType.FULL_DAY,
        page: 1,
        limit: 12,
      });

      const countArgs = databaseServiceMock.car.count.mock.calls[0][0];
      const findManyArgs = databaseServiceMock.car.findMany.mock.calls[0][0];
      expect(findManyArgs.where).toEqual(countArgs.where);
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

    it("enriches returned cars with promotion when available", async () => {
      const cars = [createMockCar({ id: "car-promoted" })];
      databaseServiceMock.car.count.mockResolvedValueOnce(1);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(cars);
      promotionServiceMock.getActivePromotionsForCars.mockResolvedValueOnce(
        new Map([
          [
            "car-promoted",
            {
              id: "promo-1",
              name: "Weekend Deal",
              discountValue: 20,
            },
          ],
        ]),
      );

      const result = await service.searchCars({ page: 1, limit: 12 });

      expect(result.cars[0]?.promotion).toEqual({
        id: "promo-1",
        name: "Weekend Deal",
        discountValue: 20,
      });
    });

    it("uses query.from as promotion reference date when provided", async () => {
      const from = new Date("2026-03-01T00:00:00.000Z");
      databaseServiceMock.user.findMany.mockResolvedValueOnce([]);
      databaseServiceMock.car.count.mockResolvedValueOnce(0);
      databaseServiceMock.car.findMany.mockResolvedValueOnce([]);

      await service.searchCars({ from, page: 1, limit: 12 });

      expect(promotionServiceMock.getActivePromotionsForCars).toHaveBeenCalledWith([], from);
    });

    it("returns cars when promotion enrichment fails", async () => {
      const cars = [createMockCar({ id: "car-1" })];
      databaseServiceMock.car.count.mockResolvedValueOnce(1);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(cars);
      promotionServiceMock.getActivePromotionsForCars.mockRejectedValueOnce(
        new Error("promotion down"),
      );

      const result = await service.searchCars({ page: 1, limit: 12 });

      expect(result.cars).toHaveLength(1);
      expect(result.cars[0]?.id).toBe("car-1");
      expect(result.cars[0]?.promotion).toBeNull();
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

      expect(result).toMatchObject({
        id: "car-123",
        owner: { username: "fleetowner1", name: "Fleet Owner" },
        promotion: null,
      });
      expect("ownerId" in result).toBe(false);
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

    it("returns promotion on public car detail when one is active", async () => {
      const mockCar = {
        ...createMockCar({ id: "car-123", ownerId: "owner-123" }),
        hourlyRate: 5000,
        fuelUpgradeRate: 10000,
      };
      databaseServiceMock.car.findFirst.mockResolvedValueOnce(mockCar);
      promotionServiceMock.getActivePromotionForCar.mockResolvedValueOnce({
        id: "promo-1",
        name: "Weekend Deal",
        discountValue: 25,
      });

      const result = await service.getPublicCarById("car-123");

      expect(result.promotion).toEqual({
        id: "promo-1",
        name: "Weekend Deal",
        discountValue: 25,
      });
      expect(promotionServiceMock.getActivePromotionForCar).toHaveBeenCalledWith(
        "car-123",
        "owner-123",
        expect.any(Date),
      );
    });

    it("uses provided reference date for public car promotion lookup", async () => {
      const referenceDate = new Date("2026-03-20T09:30:00.000Z");
      const mockCar = {
        ...createMockCar({ id: "car-123", ownerId: "owner-123" }),
        hourlyRate: 5000,
        fuelUpgradeRate: 10000,
      };
      databaseServiceMock.car.findFirst.mockResolvedValueOnce(mockCar);

      await service.getPublicCarById("car-123", referenceDate);

      expect(promotionServiceMock.getActivePromotionForCar).toHaveBeenCalledWith(
        "car-123",
        "owner-123",
        referenceDate,
      );
    });

    it("returns public car detail when promotion enrichment fails", async () => {
      const mockCar = {
        ...createMockCar({ id: "car-123", ownerId: "owner-123" }),
        hourlyRate: 5000,
        fuelUpgradeRate: 10000,
      };
      databaseServiceMock.car.findFirst.mockResolvedValueOnce(mockCar);
      promotionServiceMock.getActivePromotionForCar.mockRejectedValueOnce(
        new Error("promotion down"),
      );

      const result = await service.getPublicCarById("car-123");

      expect(result.id).toBe("car-123");
      expect(result.promotion).toBeNull();
    });
  });
});
