import { Injectable } from "@nestjs/common";
import {
  BookingStatus,
  BookingType,
  CarApprovalStatus,
  PaymentStatus,
  Prisma,
  type ServiceTier,
  Status,
  type VehicleType,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { buildBufferedBookingInterval } from "../../shared/availability-buffer.helper";
import { normalizeBookingTimeWindow } from "../../shared/booking-time-window.helper";
import { DatabaseService } from "../database/database.service";
import { CarException, CarFetchFailedException, CarNotFoundException } from "./car.error";
import { CarPromotionEnrichmentService } from "./car-promotion.enrichment";
import type {
  CarSearchQueryDto,
  CarSearchResponseDto,
  MappedQueryFilters,
  PublicCarDetailDto,
  SearchFacetsDto,
} from "./dto/car-search.dto";
import { mapQueryToFilters } from "./dto/car-search.dto";

interface AvailabilityInterval {
  startDate: Date;
  endDate: Date;
}

type RateField = "dayRate" | "nightRate" | "fullDayRate" | "airportPickupRate";

@Injectable()
export class CarSearchService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly carPromotionEnrichmentService: CarPromotionEnrichmentService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CarSearchService.name);
  }

  /**
   * Parses search query params, applying free-text mapping if needed.
   * Returns resolved filters with any mapped values from the query string.
   */
  private parseSearchFilters(query: CarSearchQueryDto): {
    serviceTiers: ServiceTier[];
    vehicleTypes: VehicleType[];
    makes: string[];
    makeModelQuery: string | null;
  } {
    const serviceTiers = [...(query.serviceTier ?? [])];
    const vehicleTypes = [...(query.vehicleType ?? [])];
    const makes = query.make ?? [];
    let makeModelQuery: string | null = null;

    // Free-text query only contributes when no explicit type/tier filters are set.
    if (query.q && serviceTiers.length === 0 && vehicleTypes.length === 0) {
      const mapped: MappedQueryFilters = mapQueryToFilters(query.q);
      if (mapped.vehicleType) vehicleTypes.push(mapped.vehicleType);
      if (mapped.serviceTier) serviceTiers.push(mapped.serviceTier);
      makeModelQuery = mapped.remainingQuery?.trim() || null;
    }

    // If nothing mapped, fall back to searching make/model with the raw query.
    if (query.q && serviceTiers.length === 0 && vehicleTypes.length === 0 && !makeModelQuery) {
      makeModelQuery = query.q.trim();
    }

    return { serviceTiers, vehicleTypes, makes, makeModelQuery };
  }

  private static readonly RATE_FIELD_BY_BOOKING_TYPE: Record<BookingType, RateField> = {
    [BookingType.DAY]: "dayRate",
    [BookingType.NIGHT]: "nightRate",
    [BookingType.FULL_DAY]: "fullDayRate",
    [BookingType.AIRPORT_PICKUP]: "airportPickupRate",
  };

  /** Base visibility: cars that are publicly listable regardless of user filters. */
  private buildBaseVisibilityWhere(fleetOwnersToExclude: string[]): Prisma.CarWhereInput {
    return {
      ...(fleetOwnersToExclude.length > 0 && {
        ownerId: { notIn: fleetOwnersToExclude },
      }),
      status: { in: [Status.AVAILABLE, Status.BOOKED] },
      approvalStatus: CarApprovalStatus.APPROVED,
      owner: { fleetOwnerStatus: "APPROVED", hasOnboarded: true },
    };
  }

  /** A car is "on promotion" via its own active promo or its owner's fleet-wide one. */
  private buildDealsOnlyWhere(referenceDate: Date): Prisma.CarWhereInput {
    // ponytail: inlines PromotionService.activeAtWhere (the canonical active-window
    // predicate). Unify into a shared export if a third copy of this appears.
    const active = {
      isActive: true,
      startDate: { lte: referenceDate },
      endDate: { gt: referenceDate },
    };
    return {
      OR: [
        { promotions: { some: active } },
        { owner: { promotions: { some: { ...active, carId: null } } } },
      ],
    };
  }

  /**
   * Builds Prisma where clause for car search
   */
  private buildWhereClause(
    params: {
      serviceTiers: ServiceTier[];
      vehicleTypes: VehicleType[];
      makes: string[];
      minPrice: number | undefined;
      maxPrice: number | undefined;
      minCapacity: number | undefined;
      fuelIncluded: boolean | undefined;
      dealsOnly: boolean | undefined;
      color: string | undefined;
      model: string | undefined;
      makeModelQuery: string | null;
      rateField: RateField;
      referenceDate: Date;
    },
    fleetOwnersToExclude: string[],
  ): Prisma.CarWhereInput {
    const hasPriceFilter = params.minPrice !== undefined || params.maxPrice !== undefined;

    const andClauses: Prisma.CarWhereInput[] = [
      this.buildBaseVisibilityWhere(fleetOwnersToExclude),
      {
        ...(params.serviceTiers.length > 0 && { serviceTier: { in: params.serviceTiers } }),
        ...(params.vehicleTypes.length > 0 && { vehicleType: { in: params.vehicleTypes } }),
        ...(params.minCapacity !== undefined && {
          passengerCapacity: { gte: params.minCapacity },
        }),
        ...(params.fuelIncluded && { pricingIncludesFuel: true }),
        ...(hasPriceFilter && {
          [params.rateField]: {
            ...(params.minPrice !== undefined && { gte: params.minPrice }),
            ...(params.maxPrice !== undefined && { lte: params.maxPrice }),
          },
        }),
        ...(params.color && {
          color: { contains: params.color, mode: Prisma.QueryMode.insensitive },
        }),
        ...(params.model && {
          model: { contains: params.model, mode: Prisma.QueryMode.insensitive },
        }),
        ...(params.makeModelQuery && {
          OR: [
            { make: { contains: params.makeModelQuery, mode: Prisma.QueryMode.insensitive } },
            { model: { contains: params.makeModelQuery, mode: Prisma.QueryMode.insensitive } },
          ],
        }),
      },
      // Separate AND entry so the makes OR doesn't collide with makeModelQuery's OR.
      // Selected makes come from the facet list, so match exactly (case-insensitive)
      // rather than substring — "BMW" must not also pull in "BMW X".
      ...(params.makes.length > 0
        ? [
            {
              OR: params.makes.map((make) => ({
                make: { equals: make, mode: Prisma.QueryMode.insensitive },
              })),
            },
          ]
        : []),
      ...(params.dealsOnly ? [this.buildDealsOnlyWhere(params.referenceDate)] : []),
    ];

    return { AND: andClauses };
  }

  /**
   * Aggregates facet data (make counts + price bounds) over base visibility only,
   * so all options stay visible regardless of the user's current selections.
   */
  private async getSearchFacets(
    baseWhere: Prisma.CarWhereInput,
    rateField: RateField,
  ): Promise<SearchFacetsDto> {
    const [makeGroups, priceAggregate] = await Promise.all([
      this.databaseService.car.groupBy({
        by: ["make"],
        where: baseWhere,
        _count: { _all: true },
      }),
      this.databaseService.car.aggregate({
        where: baseWhere,
        _min: { dayRate: true, nightRate: true, fullDayRate: true, airportPickupRate: true },
        _max: { dayRate: true, nightRate: true, fullDayRate: true, airportPickupRate: true },
      }),
    ]);

    // Merge dirty values like "Toyota " and "Toyota" into a single entry.
    const makeMap = new Map<string, { name: string; count: number }>();
    for (const group of makeGroups) {
      const name = group.make.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const existing = makeMap.get(key);
      if (existing) {
        existing.count += group._count._all;
      } else {
        makeMap.set(key, { name, count: group._count._all });
      }
    }

    const makes = [...makeMap.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    );

    return {
      makes,
      price: {
        min: priceAggregate._min[rateField] ?? 0,
        max: priceAggregate._max[rateField] ?? 0,
      },
    };
  }

  /**
   * Gets fleet owners who have no chauffeurs or all chauffeurs are busy on a specific date.
   * Used to exclude their cars from search results for that date.
   */
  private async getUnavailableFleetOwners(date: Date): Promise<string[]> {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();

    const startOfDay = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
    const endOfDay = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));

    const unavailableOwners = await this.databaseService.user.findMany({
      where: {
        cars: { some: {} },
        isOwnerDriver: false,
        OR: [
          { chauffeurs: { none: {} } },
          {
            chauffeurs: {
              some: {},
              every: {
                bookingsAsChauffeur: {
                  some: {
                    status: {
                      in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.ACTIVE],
                    },
                    AND: [{ startDate: { lte: endOfDay } }, { endDate: { gte: startOfDay } }],
                  },
                },
              },
            },
          },
        ],
      },
      select: { id: true },
      distinct: ["id"],
    });

    this.logger.debug(
      { unavailableOwners: unavailableOwners.length, date: date.toISOString() },
      "Computed unavailable fleet owners",
    );

    return unavailableOwners.map((owner) => owner.id);
  }

  private buildRequestedAvailabilityInterval(
    query: CarSearchQueryDto,
  ): AvailabilityInterval | null {
    if (!query.from || !query.to || !query.bookingType) {
      return null;
    }

    const normalized = normalizeBookingTimeWindow({
      bookingType: query.bookingType,
      startDate: query.from,
      endDate: query.to,
      pickupTime: query.pickupTime,
    });

    // Keep airport pickup search usable when only date-level bounds are provided.
    if (
      query.bookingType === BookingType.AIRPORT_PICKUP &&
      normalized.endDate.getTime() <= normalized.startDate.getTime()
    ) {
      return {
        startDate: normalized.startDate,
        endDate: new Date(normalized.startDate.getTime() + 3 * 60 * 60 * 1000),
      };
    }

    return normalized;
  }

  private applyAvailabilityExclusionToWhere(
    whereClause: Prisma.CarWhereInput,
    interval: AvailabilityInterval | null,
  ): Prisma.CarWhereInput {
    if (!interval) {
      return whereClause;
    }

    const { bufferedStart, bufferedEnd } = buildBufferedBookingInterval(interval);
    return {
      AND: [
        whereClause,
        {
          bookings: {
            none: {
              paymentStatus: PaymentStatus.PAID,
              status: { in: [BookingStatus.CONFIRMED, BookingStatus.ACTIVE] },
              startDate: { lt: bufferedEnd },
              endDate: { gt: bufferedStart },
            },
          },
        },
      ],
    };
  }

  /**
   * Main search method - fetches cars matching the query and filters by availability.
   */
  async searchCars(query: CarSearchQueryDto): Promise<CarSearchResponseDto> {
    const startTime = Date.now();

    try {
      // Parse filters from query
      const { serviceTiers, vehicleTypes, makes, makeModelQuery } = this.parseSearchFilters(query);
      const rateField = query.bookingType
        ? CarSearchService.RATE_FIELD_BY_BOOKING_TYPE[query.bookingType]
        : "dayRate";
      // One reference date drives both the deals-only filter and promotion enrichment,
      // so a dated search never disagrees with itself about which promos are active.
      const referenceDate = query.from ?? new Date();

      // Get unavailable fleet owners for the date if provided
      const fleetOwnersToExclude = query.from
        ? await this.getUnavailableFleetOwners(query.from)
        : [];

      // Check if we have all required params for exact availability filtering
      const canFilterByAvailability = Boolean(query.from && query.to && query.bookingType);

      const availabilityInterval = canFilterByAvailability
        ? this.buildRequestedAvailabilityInterval(query)
        : null;

      // Build where clause
      const whereClause = this.buildWhereClause(
        {
          serviceTiers,
          vehicleTypes,
          makes,
          minPrice: query.minPrice,
          maxPrice: query.maxPrice,
          minCapacity: query.minCapacity,
          fuelIncluded: query.fuelIncluded,
          dealsOnly: query.dealsOnly,
          color: query.color,
          model: query.model,
          makeModelQuery,
          rateField,
          referenceDate,
        },
        fleetOwnersToExclude,
      );
      const searchWhereClause = this.applyAvailabilityExclusionToWhere(
        whereClause,
        availabilityInterval,
      );

      const filters = {
        serviceTiers,
        vehicleTypes,
        bookingType: query.bookingType ?? null,
      };

      // Lightweight count-only mode for the filter panel's live "Show N vehicles".
      if (query.countOnly) {
        const total = await this.databaseService.car.count({ where: searchWhereClause });
        return {
          cars: [],
          filters,
          facets: null,
          pagination: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages: Math.ceil(total / query.limit),
            hasNextPage: false,
            hasPreviousPage: false,
          },
        };
      }

      // Pagination setup
      const take = query.limit;
      const skip = (query.page - 1) * query.limit;

      const [totalCount, cars, facets] = await Promise.all([
        this.databaseService.car.count({ where: searchWhereClause }),
        this.databaseService.car.findMany({
          where: searchWhereClause,
          select: {
            id: true,
            ownerId: true,
            make: true,
            model: true,
            year: true,
            color: true,
            dayRate: true,
            nightRate: true,
            fullDayRate: true,
            airportPickupRate: true,
            passengerCapacity: true,
            pricingIncludesFuel: true,
            vehicleType: true,
            serviceTier: true,
            // hireApp parity: an approved car shows all its images regardless of
            // per-image status. The car is already gated on approvalStatus above.
            images: {
              select: { url: true },
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
              take: 4,
            },
            owner: { select: { username: true, name: true } },
          },
          orderBy: [{ updatedAt: "desc" }, { dayRate: "asc" }],
          skip,
          take,
        }),
        this.getSearchFacets(this.buildBaseVisibilityWhere(fleetOwnersToExclude), rateField),
      ]);
      const carsWithPromotion = await this.carPromotionEnrichmentService.enrichCarsWithPromotion({
        cars,
        referenceDate,
        failureMessage: "Failed to enrich search results with promotions",
      });

      const enrichedCars = carsWithPromotion.map(({ ownerId: _ownerId, ...car }) => car);

      // Calculate pagination
      const totalPages = Math.ceil(totalCount / query.limit);
      const hasNextPage = query.page < totalPages;
      const hasPreviousPage = query.page > 1;

      const totalTime = Date.now() - startTime;
      this.logger.info(
        {
          totalTimeMs: totalTime,
          totalCount,
          returnedCount: cars.length,
          page: query.page,
        },
        "Search completed",
      );

      return {
        cars: enrichedCars,
        filters,
        facets,
        pagination: {
          page: query.page,
          limit: query.limit,
          total: totalCount,
          totalPages,
          hasNextPage,
          hasPreviousPage,
        },
      };
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          query,
        },
        "Search failed",
      );
      throw new CarFetchFailedException();
    }
  }

  /**
   * Fetches a single car by ID for public display.
   * Only returns approved cars from approved fleet owners.
   */
  async getPublicCarById(carId: string, referenceDate?: Date): Promise<PublicCarDetailDto> {
    try {
      const car = await this.databaseService.car.findFirst({
        where: {
          id: carId,
          status: { in: [Status.AVAILABLE, Status.BOOKED] },
          approvalStatus: CarApprovalStatus.APPROVED,
          owner: { fleetOwnerStatus: "APPROVED", hasOnboarded: true },
        },
        select: {
          id: true,
          ownerId: true,
          make: true,
          model: true,
          year: true,
          color: true,
          dayRate: true,
          hourlyRate: true,
          nightRate: true,
          fullDayRate: true,
          airportPickupRate: true,
          fuelUpgradeRate: true,
          passengerCapacity: true,
          pricingIncludesFuel: true,
          vehicleType: true,
          serviceTier: true,
          // hireApp parity: an approved car shows all its images regardless of
          // per-image status. The car is already gated on approvalStatus above.
          images: {
            select: { url: true },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
          },
          owner: { select: { username: true, name: true } },
        },
      });

      if (!car) {
        throw new CarNotFoundException();
      }

      const carWithPromotion = await this.carPromotionEnrichmentService.enrichCarWithPromotion({
        car,
        referenceDate: referenceDate ?? new Date(),
        failureMessage: "Failed to enrich public car with promotion",
      });
      const { ownerId: _ownerId, ...publicCar } = carWithPromotion;

      return publicCar;
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      this.logger.error(
        {
          carId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to fetch public car",
      );
      throw new CarFetchFailedException();
    }
  }
}
