import { createHash } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingType, ChauffeurApprovalStatus, ServiceTier, VehicleType } from "@prisma/client";
import { validate as isUuid } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import type { AvailabilitySearchFilters } from "../analytics/analytics.interface";
import { AnalyticsChannel, AvailabilitySearchOutcome } from "../analytics/analytics-event.schema";
import { AnalyticsIngestionService } from "../analytics/analytics-ingestion.service";
import { BLOCKING_BOOKING_STATUSES } from "../booking/booking.const";
import { DatabaseService } from "../database/database.service";
import { PromotionService } from "../promotion/promotion.service";
import { ReviewsReadService } from "../reviews/reviews-read.service";
import { CarFetchFailedException, CarNotFoundException } from "./car.error";
import { CarPromotionEnrichmentService } from "./car-promotion.enrichment";
import { CarRatingsEnrichmentService } from "./car-ratings.enrichment";
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
      groupBy: vi.fn(),
      aggregate: vi.fn(),
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
  const reviewsReadServiceMock = {
    getBatchCarRatings: vi.fn(),
  };
  const analyticsIngestionServiceMock = {
    recordAvailabilitySearchCompleted: vi.fn().mockResolvedValue(undefined),
    recordAvailabilitySearchFailed: vi.fn().mockResolvedValue(undefined),
  };
  const clientSearchId = "01994a1d-4263-7000-8000-0000000000aa";
  const analyticsMarket = {
    countryCode: "NG",
    marketCode: "LAGOS",
    timezone: "Africa/Lagos",
  } as const;
  const availabilityQuery = {
    from: new Date("2024-03-01T00:00:00.000Z"),
    to: new Date("2024-03-02T00:00:00.000Z"),
    bookingType: BookingType.DAY,
    page: 1,
    limit: 12,
  };
  const dayFilters: AvailabilitySearchFilters = {
    bookingType: BookingType.DAY,
    vehicleTypes: [],
    serviceTiers: [],
    from: "2024-03-01T07:00:00.000Z",
    to: "2024-03-02T19:00:00.000Z",
    pickupTime: null,
    minPrice: null,
    maxPrice: null,
    minCapacity: null,
    fuelIncluded: null,
    dealsOnly: null,
  };

  function filterFingerprint(filters: AvailabilitySearchFilters): string {
    return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
  }

  function webContext(searchId?: string) {
    return {
      channel: AnalyticsChannel.WEB,
      searchId,
      anonymousSessionId: "01994a1d-4263-7000-8000-0000000000bb",
      requestId: "req-web-1",
    };
  }

  function stubAvailabilitySearch(total: number) {
    databaseServiceMock.user.findMany.mockResolvedValueOnce([]);
    databaseServiceMock.car.count.mockResolvedValueOnce(total);
    databaseServiceMock.car.findMany.mockResolvedValueOnce(
      total > 0 ? [createMockCar({ id: "car-match" })] : [],
    );
  }

  const createMockCar = (
    overrides: Partial<SearchCarDto & { ownerId: string }> = {},
  ): SearchCarDto & { ownerId: string } => ({
    id: `car-${mockCarIdCounter++}`,
    publicRef: "0123456789abcdef",
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
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    owner: { username: "fleetowner1", name: "Fleet Owner" },
    promotion: null,
    averageRating: 0,
    totalReviews: 0,
    ...overrides,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCarIdCounter = 0;
    databaseServiceMock.booking.findMany.mockResolvedValue([]);
    databaseServiceMock.car.groupBy.mockResolvedValue([]);
    databaseServiceMock.car.aggregate.mockResolvedValue({ _min: {}, _max: {} });
    promotionServiceMock.getActivePromotionsForCars.mockResolvedValue(new Map());
    promotionServiceMock.getActivePromotionForCar.mockResolvedValue(null);
    reviewsReadServiceMock.getBatchCarRatings.mockResolvedValue(new Map());
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CarSearchService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: AnalyticsIngestionService, useValue: analyticsIngestionServiceMock },
        { provide: PromotionService, useValue: promotionServiceMock },
        { provide: ReviewsReadService, useValue: reviewsReadServiceMock },
        CarPromotionEnrichmentService,
        CarRatingsEnrichmentService,
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

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
        serviceTier: [ServiceTier.LUXURY],
        page: 1,
        limit: 12,
      });

      expect(result.cars).toHaveLength(2);
      expect(result.filters.serviceTiers).toEqual([ServiceTier.LUXURY]);
    });

    it("returns cars matching vehicleType filter", async () => {
      const suvCars = [
        createMockCar({ id: "suv-1", vehicleType: VehicleType.SUV }),
        createMockCar({ id: "suv-2", vehicleType: VehicleType.SUV }),
      ];
      databaseServiceMock.car.count.mockResolvedValueOnce(2);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(suvCars);

      const result = await service.searchCars({
        vehicleType: [VehicleType.SUV],
        page: 1,
        limit: 12,
      });

      expect(result.cars).toHaveLength(2);
      expect(result.filters.vehicleTypes).toEqual([VehicleType.SUV]);
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

      expect(result.filters.serviceTiers).toEqual([ServiceTier.LUXURY]);
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
      expect(result.filters.serviceTiers).toEqual([]);
      expect(result.filters.vehicleTypes).toEqual([]);
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

    it("excludes a fleet only when neither an owner-driver nor a fleet chauffeur is free", async () => {
      const unavailableOwners = [{ id: "owner-busy" }];
      databaseServiceMock.user.findMany.mockResolvedValueOnce(unavailableOwners);
      databaseServiceMock.car.count.mockResolvedValueOnce(5);
      databaseServiceMock.car.findMany.mockResolvedValueOnce([createMockCar({ id: "car-1" })]);

      await service.searchCars({
        from: new Date("2024-03-01"),
        page: 1,
        limit: 12,
      });

      const bookingConflict = {
        deletedAt: null,
        status: { in: [...BLOCKING_BOOKING_STATUSES] },
        startDate: { lt: new Date("2024-03-02T02:00:00.000Z") },
        endDate: { gt: new Date("2024-02-29T22:00:00.000Z") },
      };
      expect(databaseServiceMock.user.findMany).toHaveBeenCalledWith({
        where: {
          cars: { some: {} },
          NOT: {
            OR: [
              {
                isOwnerDriver: true,
                chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
                chauffeurDisabledAt: null,
                bookingsAsChauffeur: { none: bookingConflict },
              },
              {
                chauffeurs: {
                  some: {
                    chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
                    chauffeurDisabledAt: null,
                    bookingsAsChauffeur: { none: bookingConflict },
                  },
                },
              },
            ],
          },
        },
        select: { id: true },
        distinct: ["id"],
      });
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
                    deletedAt: null,
                    status: { in: [...BLOCKING_BOOKING_STATUSES] },
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

    it("enriches returned cars with ratings when available", async () => {
      const cars = [createMockCar({ id: "car-rated" })];
      databaseServiceMock.car.count.mockResolvedValueOnce(1);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(cars);
      reviewsReadServiceMock.getBatchCarRatings.mockResolvedValueOnce(
        new Map([
          [
            "car-rated",
            {
              averageRating: 5,
              totalReviews: 1,
              ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 },
            },
          ],
        ]),
      );

      const result = await service.searchCars({ page: 1, limit: 12 });

      expect(result.cars[0]?.averageRating).toBe(5);
      expect(result.cars[0]?.totalReviews).toBe(1);
    });

    it("returns cars with zero ratings when ratings enrichment fails", async () => {
      const cars = [createMockCar({ id: "car-1" })];
      databaseServiceMock.car.count.mockResolvedValueOnce(1);
      databaseServiceMock.car.findMany.mockResolvedValueOnce(cars);
      reviewsReadServiceMock.getBatchCarRatings.mockRejectedValueOnce(new Error("ratings down"));

      const result = await service.searchCars({ page: 1, limit: 12 });

      expect(result.cars).toHaveLength(1);
      expect(result.cars[0]?.averageRating).toBe(0);
      expect(result.cars[0]?.totalReviews).toBe(0);
    });

    it("only selects approved images for public search results", async () => {
      databaseServiceMock.car.count.mockResolvedValueOnce(0);
      databaseServiceMock.car.findMany.mockResolvedValueOnce([]);

      await service.searchCars({ page: 1, limit: 12 });

      expect(databaseServiceMock.car.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            createdAt: true,
            images: expect.objectContaining({
              select: { url: true },
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            }),
          }),
        }),
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
        serviceTier: [ServiceTier.EXECUTIVE],
        vehicleType: [VehicleType.SUV],
        make: ["Toyota"],
        page: 1,
        limit: 12,
      });

      expect(result.cars).toHaveLength(1);
      expect(result.filters.serviceTiers).toEqual([ServiceTier.EXECUTIVE]);
      expect(result.filters.vehicleTypes).toEqual([VehicleType.SUV]);
    });

    it("filters by multiple vehicle types, price, capacity, fuel and deals", async () => {
      databaseServiceMock.car.count.mockResolvedValueOnce(1);
      databaseServiceMock.car.findMany.mockResolvedValueOnce([createMockCar({ id: "car-1" })]);

      await service.searchCars({
        vehicleType: [VehicleType.SUV, VehicleType.SEDAN],
        minPrice: 40000,
        maxPrice: 90000,
        minCapacity: 5,
        fuelIncluded: true,
        dealsOnly: true,
        bookingType: BookingType.NIGHT,
        page: 1,
        limit: 12,
      });

      const andClauses = databaseServiceMock.car.findMany.mock.calls[0][0].where.AND;
      expect(andClauses[1]).toMatchObject({
        vehicleType: { in: [VehicleType.SUV, VehicleType.SEDAN] },
        passengerCapacity: { gte: 5 },
        pricingIncludesFuel: true,
        // Price filters the booking-type rate field, not dayRate.
        nightRate: { gte: 40000, lte: 90000 },
      });

      // dealsOnly must require an active car-level OR fleet-wide promotion,
      // both date-bounded so removing either branch fails this test.
      const dealsClause = andClauses.at(-1);
      expect(dealsClause.OR).toEqual([
        {
          promotions: {
            some: {
              isActive: true,
              startDate: { lte: expect.any(Date) },
              endDate: { gt: expect.any(Date) },
            },
          },
        },
        {
          owner: {
            promotions: {
              some: {
                isActive: true,
                startDate: { lte: expect.any(Date) },
                endDate: { gt: expect.any(Date) },
                carId: null,
              },
            },
          },
        },
      ]);
    });

    it("countOnly returns total without cars or facets", async () => {
      databaseServiceMock.car.count.mockResolvedValueOnce(42);

      const result = await service.searchCars({
        serviceTier: [ServiceTier.LUXURY],
        countOnly: true,
        page: 1,
        limit: 12,
      });

      expect(result.cars).toEqual([]);
      expect(result.facets).toBeNull();
      expect(result.pagination.total).toBe(42);
      expect(databaseServiceMock.car.findMany).not.toHaveBeenCalled();
    });

    it("returns facets (make counts + price bounds) on normal search", async () => {
      databaseServiceMock.car.count.mockResolvedValueOnce(3);
      databaseServiceMock.car.findMany.mockResolvedValueOnce([createMockCar({ id: "car-1" })]);
      databaseServiceMock.car.groupBy.mockResolvedValueOnce([
        { make: "Toyota", _count: { _all: 2 } },
        { make: "toyota ", _count: { _all: 1 } },
        { make: "Lexus", _count: { _all: 1 } },
      ]);
      databaseServiceMock.car.aggregate.mockResolvedValueOnce({
        _min: { dayRate: 30000, nightRate: 40000, fullDayRate: 0, airportPickupRate: 0 },
        _max: { dayRate: 90000, nightRate: 120000, fullDayRate: 0, airportPickupRate: 0 },
      });

      const result = await service.searchCars({ page: 1, limit: 12 });

      // Dirty duplicates merged, sorted by count desc.
      expect(result.facets?.makes).toEqual([
        { name: "Toyota", count: 3 },
        { name: "Lexus", count: 1 },
      ]);
      // Default booking type uses dayRate bounds.
      expect(result.facets?.price).toEqual({ min: 30000, max: 90000 });
    });
  });

  describe("availability search analytics", () => {
    it("does not record an event or run a supplemental count for countOnly", async () => {
      databaseServiceMock.user.findMany.mockResolvedValueOnce([]);
      databaseServiceMock.car.count.mockResolvedValueOnce(0);

      const result = await service.searchCars(
        { ...availabilityQuery, countOnly: true },
        webContext(clientSearchId),
      );

      expect(result.cars).toEqual([]);
      expect(result.pagination.total).toBe(0);
      expect(result.searchId).toBeUndefined();
      expect(databaseServiceMock.car.count).toHaveBeenCalledTimes(1);
      expect(databaseServiceMock.car.findMany).not.toHaveBeenCalled();
      expect(
        analyticsIngestionServiceMock.recordAvailabilitySearchCompleted,
      ).not.toHaveBeenCalled();
      expect(analyticsIngestionServiceMock.recordAvailabilitySearchFailed).not.toHaveBeenCalled();
    });

    it("does not record an event for browsing that lacks a full availability window", async () => {
      databaseServiceMock.car.count.mockResolvedValueOnce(0);
      databaseServiceMock.car.findMany.mockResolvedValueOnce([]);

      const result = await service.searchCars(
        { page: 1, limit: 12, q: "camry", make: ["Toyota"], model: "Camry", color: "Black" },
        webContext(clientSearchId),
      );

      expect(result.searchId).toBeUndefined();
      expect(databaseServiceMock.car.count).toHaveBeenCalledTimes(1);
      expect(
        analyticsIngestionServiceMock.recordAvailabilitySearchCompleted,
      ).not.toHaveBeenCalled();
      expect(analyticsIngestionServiceMock.recordAvailabilitySearchFailed).not.toHaveBeenCalled();
    });

    it("records matches and returns the client search id without a supplemental count", async () => {
      stubAvailabilitySearch(1);

      const result = await service.searchCars(availabilityQuery, webContext(clientSearchId));

      expect(result.searchId).toBe(clientSearchId);
      expect(result.cars).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(databaseServiceMock.car.count).toHaveBeenCalledTimes(1);
      expect(analyticsIngestionServiceMock.recordAvailabilitySearchCompleted).toHaveBeenCalledWith({
        context: webContext(clientSearchId),
        occurredAt: expect.any(Date),
        payload: {
          filters: dayFilters,
          filterFingerprint: filterFingerprint(dayFilters),
          resultCount: 1,
          filterMatchCount: null,
          outcome: AvailabilitySearchOutcome.MATCHES_FOUND,
          market: analyticsMarket,
        },
      });
      expect(analyticsIngestionServiceMock.recordAvailabilitySearchFailed).not.toHaveBeenCalled();
    });

    it("keeps a successful search result when analytics recording resolves", async () => {
      stubAvailabilitySearch(1);
      analyticsIngestionServiceMock.recordAvailabilitySearchCompleted.mockResolvedValueOnce(
        undefined,
      );

      const result = await service.searchCars(availabilityQuery, webContext(clientSearchId));

      expect(result.cars.map((car) => car.id)).toEqual(["car-match"]);
      expect(result.pagination).toEqual(expect.objectContaining({ total: 1, page: 1, limit: 12 }));
      expect(analyticsIngestionServiceMock.recordAvailabilitySearchCompleted).toHaveBeenCalledTimes(
        1,
      );
    });

    it("classifies zero results and zero filter matches as NO_MATCH_FILTERS", async () => {
      stubAvailabilitySearch(0);
      databaseServiceMock.car.count.mockResolvedValueOnce(0);

      const result = await service.searchCars(availabilityQuery, webContext(clientSearchId));

      expect(result.cars).toEqual([]);
      expect(result.pagination.total).toBe(0);
      expect(databaseServiceMock.car.count).toHaveBeenCalledTimes(2);
      expect(analyticsIngestionServiceMock.recordAvailabilitySearchCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            resultCount: 0,
            filterMatchCount: 0,
            outcome: AvailabilitySearchOutcome.NO_MATCH_FILTERS,
          }),
        }),
      );
    });

    it("classifies zero results with filter matches as NO_MATCH_AVAILABILITY", async () => {
      stubAvailabilitySearch(0);
      databaseServiceMock.car.count.mockResolvedValueOnce(4);

      await service.searchCars(availabilityQuery, webContext(clientSearchId));

      const searchWhere = databaseServiceMock.car.count.mock.calls[0][0].where;
      const filterWhere = databaseServiceMock.car.count.mock.calls[1][0].where;
      expect(filterWhere).not.toEqual(searchWhere);
      expect(analyticsIngestionServiceMock.recordAvailabilitySearchCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            resultCount: 0,
            filterMatchCount: 4,
            outcome: AvailabilitySearchOutcome.NO_MATCH_AVAILABILITY,
          }),
        }),
      );
    });

    it("returns the empty search when supplemental classification fails", async () => {
      stubAvailabilitySearch(0);
      databaseServiceMock.car.count.mockRejectedValueOnce(new Error("count failed"));

      const result = await service.searchCars(availabilityQuery, webContext(clientSearchId));

      expect(result.cars).toEqual([]);
      expect(result.pagination.total).toBe(0);
      expect(result.searchId).toBe(clientSearchId);
      expect(analyticsIngestionServiceMock.recordAvailabilitySearchCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            resultCount: 0,
            filterMatchCount: null,
            outcome: AvailabilitySearchOutcome.NO_MATCH_UNCLASSIFIED,
          }),
        }),
      );
      expect(analyticsIngestionServiceMock.recordAvailabilitySearchFailed).not.toHaveBeenCalled();
    });

    it("records a failed search and preserves the original exception", async () => {
      const notFound = new CarNotFoundException();
      databaseServiceMock.user.findMany.mockRejectedValueOnce(notFound);

      await expect(service.searchCars(availabilityQuery, webContext(clientSearchId))).rejects.toBe(
        notFound,
      );

      expect(analyticsIngestionServiceMock.recordAvailabilitySearchFailed).toHaveBeenCalledWith({
        context: webContext(clientSearchId),
        occurredAt: expect.any(Date),
        payload: {
          filters: dayFilters,
          filterFingerprint: filterFingerprint(dayFilters),
          errorCode: "SEARCH_EXECUTION_FAILED",
          market: analyticsMarket,
        },
      });
      expect(
        analyticsIngestionServiceMock.recordAvailabilitySearchCompleted,
      ).not.toHaveBeenCalled();

      analyticsIngestionServiceMock.recordAvailabilitySearchFailed.mockClear();
      databaseServiceMock.user.findMany.mockRejectedValueOnce(new Error("owners down"));

      await expect(
        service.searchCars(availabilityQuery, webContext(clientSearchId)),
      ).rejects.toThrow(CarFetchFailedException);
      expect(analyticsIngestionServiceMock.recordAvailabilitySearchFailed).toHaveBeenCalledTimes(1);
    });

    it("reuses a client search id and replaces an invalid or missing one", async () => {
      stubAvailabilitySearch(1);
      const reused = await service.searchCars(availabilityQuery, webContext(clientSearchId));
      expect(reused.searchId).toBe(clientSearchId);

      stubAvailabilitySearch(1);
      const replaced = await service.searchCars(availabilityQuery, webContext("not-a-uuid"));
      expect(replaced.searchId).not.toBe("not-a-uuid");
      expect(isUuid(replaced.searchId ?? "")).toBe(true);
      expect(
        analyticsIngestionServiceMock.recordAvailabilitySearchCompleted,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ searchId: replaced.searchId }),
        }),
      );

      stubAvailabilitySearch(1);
      const generated = await service.searchCars(availabilityQuery, webContext());
      expect(isUuid(generated.searchId ?? "")).toBe(true);
      expect(generated.searchId).not.toBe(replaced.searchId);
    });

    it("omits free-text query fields from the availability payload", async () => {
      stubAvailabilitySearch(1);
      const filters: AvailabilitySearchFilters = {
        bookingType: BookingType.DAY,
        vehicleTypes: [VehicleType.SUV],
        serviceTiers: [ServiceTier.EXECUTIVE],
        from: "2024-03-01T09:00:00.000Z",
        to: "2024-03-02T21:00:00.000Z",
        pickupTime: "9:00 AM",
        minPrice: 1000,
        maxPrice: 9000,
        minCapacity: 4,
        fuelIncluded: true,
        dealsOnly: false,
      };

      await service.searchCars(
        {
          ...availabilityQuery,
          vehicleType: [VehicleType.SUV],
          serviceTier: [ServiceTier.EXECUTIVE],
          pickupTime: "9:00 AM",
          minPrice: 1000,
          maxPrice: 9000,
          minCapacity: 4,
          fuelIncluded: true,
          dealsOnly: false,
          q: "black toyota camry",
          make: ["Toyota"],
          model: "Camry",
          color: "Black",
        },
        webContext(clientSearchId),
      );

      expect(analyticsIngestionServiceMock.recordAvailabilitySearchCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            filters,
            filterFingerprint: filterFingerprint(filters),
          }),
        }),
      );
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
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        owner: { username: "fleetowner1", name: "Fleet Owner" },
        promotion: null,
        averageRating: 0,
        totalReviews: 0,
      });
      expect("ownerId" in result).toBe(false);
      expect(databaseServiceMock.car.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "car-123",
          }),
          select: expect.objectContaining({
            createdAt: true,
            images: expect.objectContaining({
              select: { url: true },
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            }),
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

  describe("getPublicCarByRef", () => {
    it("uses the public reference as the authoritative lookup key", async () => {
      const mockCar = {
        ...createMockCar({ id: "car-123", publicRef: "0123456789abcdef" }),
        hourlyRate: 5000,
        fuelUpgradeRate: 10000,
      };
      databaseServiceMock.car.findFirst.mockResolvedValueOnce(mockCar);

      const result = await service.getPublicCarByRef("0123456789abcdef");

      expect(result.publicRef).toBe("0123456789abcdef");
      expect(databaseServiceMock.car.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            publicRef: "0123456789abcdef",
            approvalStatus: "APPROVED",
          }),
          select: expect.objectContaining({ publicRef: true }),
        }),
      );
    });
  });
});
