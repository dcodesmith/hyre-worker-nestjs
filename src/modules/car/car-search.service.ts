import { Injectable, Logger } from "@nestjs/common";
import { BookingStatus, BookingType, CarApprovalStatus, Prisma, Status } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import { CarException, CarFetchFailedException, CarNotFoundException } from "./car.error";
import type {
  CarSearchQueryDto,
  CarSearchResponseDto,
  MappedQueryFilters,
  PublicCarDetailDto,
} from "./dto/car-search.dto";
import { mapQueryToFilters } from "./dto/car-search.dto";

interface AvailabilityWindow {
  fromStart: Date;
  endWindow: Date;
}

@Injectable()
export class CarSearchService {
  private readonly logger = new Logger(CarSearchService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Parses search query params, applying free-text mapping if needed.
   * Returns resolved filters with any mapped values from the query string.
   */
  private parseSearchFilters(query: CarSearchQueryDto): {
    serviceTier: CarSearchQueryDto["serviceTier"];
    vehicleType: CarSearchQueryDto["vehicleType"];
    makeModelQuery: string | null;
  } {
    let serviceTier = query.serviceTier;
    let vehicleType = query.vehicleType;
    let makeModelQuery: string | null = null;

    // If free-text query provided and no explicit filters, try to map it
    if (query.q && !serviceTier && !vehicleType) {
      const mapped: MappedQueryFilters = mapQueryToFilters(query.q);
      if (mapped.vehicleType) vehicleType = mapped.vehicleType;
      if (mapped.serviceTier) serviceTier = mapped.serviceTier;
      makeModelQuery = mapped.remainingQuery?.trim() || null;
    }

    // If no mapping happened and there's a query, use it for make/model search
    if (query.q && !serviceTier && !vehicleType && !makeModelQuery) {
      makeModelQuery = query.q.trim();
    }

    return { serviceTier, vehicleType, makeModelQuery };
  }

  /**
   * Builds Prisma where clause for car search
   */
  private buildWhereClause(
    params: {
      serviceTier: CarSearchQueryDto["serviceTier"];
      vehicleType: CarSearchQueryDto["vehicleType"];
      color: string | undefined;
      make: string | undefined;
      model: string | undefined;
      makeModelQuery: string | null;
    },
    fleetOwnersToExclude: string[],
    availabilityWindow: AvailabilityWindow | null,
  ): Prisma.CarWhereInput {
    return {
      AND: [
        {
          ...(fleetOwnersToExclude.length > 0 && {
            ownerId: { notIn: fleetOwnersToExclude },
          }),
          status: { in: [Status.AVAILABLE, Status.BOOKED] },
          approvalStatus: CarApprovalStatus.APPROVED,
          owner: { fleetOwnerStatus: "APPROVED", hasOnboarded: true },
          ...(params.serviceTier && { serviceTier: params.serviceTier }),
          ...(params.vehicleType && { vehicleType: params.vehicleType }),
          ...(params.color && {
            color: { contains: params.color, mode: Prisma.QueryMode.insensitive },
          }),
          ...(params.make && {
            make: { contains: params.make, mode: Prisma.QueryMode.insensitive },
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
          ...(availabilityWindow && {
            bookings: {
              none: {
                status: { in: [BookingStatus.CONFIRMED, BookingStatus.ACTIVE] },
                AND: [
                  { startDate: { lt: availabilityWindow.endWindow } },
                  { endDate: { gt: availabilityWindow.fromStart } },
                ],
              },
            },
          }),
        },
      ],
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
      `Found ${unavailableOwners.length} unavailable fleet owners for ${date.toISOString()}`,
    );

    return unavailableOwners.map((owner) => owner.id);
  }

  private buildAvailabilityWindow(from: Date, to: Date): AvailabilityWindow {
    // Normalize from date to start of day in UTC
    const fromStart = new Date(from);
    fromStart.setUTCHours(0, 0, 0, 0);

    // End window is end of next day at 5 AM UTC
    const endWindow = new Date(to);
    endWindow.setUTCDate(endWindow.getUTCDate() + 1);
    endWindow.setUTCHours(5, 0, 0, 0);

    return { fromStart, endWindow };
  }

  /**
   * Main search method - fetches cars matching the query and filters by availability.
   */
  async searchCars(query: CarSearchQueryDto): Promise<CarSearchResponseDto> {
    const startTime = Date.now();

    try {
      // Parse filters from query
      const { serviceTier, vehicleType, makeModelQuery } = this.parseSearchFilters(query);

      // Get unavailable fleet owners for the date if provided
      const fleetOwnersToExclude = query.from
        ? await this.getUnavailableFleetOwners(query.from)
        : [];

      // Check if we have all required params for availability filtering
      const canFilterByAvailability =
        query.from &&
        query.to &&
        query.bookingType &&
        (query.pickupTime ||
          query.bookingType === BookingType.NIGHT ||
          (query.bookingType === BookingType.AIRPORT_PICKUP && query.flightNumber));
      const availabilityWindow = canFilterByAvailability
        ? this.buildAvailabilityWindow(query.from, query.to)
        : null;

      // Build where clause
      const whereClause = this.buildWhereClause(
        {
          serviceTier,
          vehicleType,
          color: query.color,
          make: query.make,
          model: query.model,
          makeModelQuery,
        },
        fleetOwnersToExclude,
        availabilityWindow,
      );

      // Pagination setup
      const take = query.limit;
      const skip = (query.page - 1) * query.limit;

      const [totalCount, cars] = await Promise.all([
        this.databaseService.car.count({ where: whereClause }),
        this.databaseService.car.findMany({
          where: whereClause,
          select: {
            id: true,
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
            images: { select: { url: true }, orderBy: { createdAt: "asc" }, take: 4 },
            owner: { select: { username: true, name: true } },
          },
          orderBy: [{ updatedAt: "desc" }, { dayRate: "asc" }],
          skip,
          take,
        }),
      ]);

      // Calculate pagination
      const totalPages = Math.ceil(totalCount / query.limit);
      const hasNextPage = query.page < totalPages;
      const hasPreviousPage = query.page > 1;

      const totalTime = Date.now() - startTime;
      this.logger.log(`Search completed in ${totalTime}ms`, {
        totalCount,
        returnedCount: cars.length,
        page: query.page,
      });

      return {
        cars,
        filters: {
          serviceTier: serviceTier ?? null,
          vehicleType: vehicleType ?? null,
          bookingType: query.bookingType ?? null,
        },
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
      this.logger.error("Search failed", {
        error: error instanceof Error ? error.message : String(error),
        query,
      });
      throw new CarFetchFailedException();
    }
  }

  /**
   * Fetches a single car by ID for public display.
   * Only returns approved cars from approved fleet owners.
   */
  async getPublicCarById(carId: string): Promise<PublicCarDetailDto> {
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
          images: { select: { url: true }, orderBy: { createdAt: "asc" } },
          owner: { select: { username: true, name: true } },
        },
      });

      if (!car) {
        throw new CarNotFoundException();
      }

      return car;
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      this.logger.error("Failed to fetch public car", {
        carId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new CarFetchFailedException();
    }
  }
}
