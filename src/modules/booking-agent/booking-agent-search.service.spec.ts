import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CarSearchService } from "../car/car-search.service";
import type { CarSearchResponseDto, SearchCarDto } from "../car/dto/car-search.dto";
import { RatesService } from "../rates/rates.service";
import { WHATSAPP_CAR_SEARCH_TIMEOUT_MS } from "./booking-agent.const";
import { WhatsAppOperationTimeoutException } from "./booking-agent.error";
import { BookingAgentSearchService } from "./booking-agent-search.service";

describe("BookingAgentSearchService", () => {
  let moduleRef: TestingModule;
  let service: BookingAgentSearchService;
  let carSearchService: { searchCars: ReturnType<typeof vi.fn> };
  let ratesService: { getRates: ReturnType<typeof vi.fn> };

  const buildSearchResponse = (cars: SearchCarDto[]): CarSearchResponseDto => ({
    cars,
    filters: {
      bookingType: null,
      serviceTier: null,
      vehicleType: null,
    },
    pagination: {
      page: 1,
      limit: 10,
      total: cars.length,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    },
  });

  const buildCar = (id: string, overrides?: Partial<SearchCarDto>): SearchCarDto => ({
    id,
    make: "Toyota",
    model: "Prado",
    year: 2022,
    color: "Black",
    dayRate: 65000,
    nightRate: 70000,
    fullDayRate: 110000,
    airportPickupRate: 40000,
    passengerCapacity: 4,
    pricingIncludesFuel: false,
    vehicleType: "SUV",
    serviceTier: "STANDARD",
    images: [{ url: `https://cdn.tripdly.test/${id}.jpg` }],
    owner: { username: "fleet-owner", name: "Fleet Owner" },
    ...overrides,
  });

  const makeIsoDate = (daysFromToday: number): string => {
    const date = new Date();
    date.setDate(date.getDate() + daysFromToday);
    return date.toISOString().split("T")[0] ?? "";
  };

  beforeEach(async () => {
    carSearchService = {
      searchCars: vi.fn(),
    };
    ratesService = {
      getRates: vi.fn().mockResolvedValue({
        platformCustomerServiceFeeRatePercent: 10,
        platformFleetOwnerCommissionRatePercent: 5,
        vatRatePercent: 7.5,
        securityDetailRate: 0,
      }),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        BookingAgentSearchService,
        {
          provide: CarSearchService,
          useValue: carSearchService,
        },
        {
          provide: RatesService,
          useValue: ratesService,
        },
      ],
    }).compile();

    service = moduleRef.get(BookingAgentSearchService);
  });

  it("returns a hard precondition prompt when pickup date is missing", async () => {
    const result = await service.searchVehiclesFromExtracted(
      {
        make: "Toyota",
        model: "Prado",
        color: "Black",
      },
      "Looking for: black toyota prado",
    );

    expect(result.precondition).toEqual({
      missingField: "from",
      prompt: "What date should pickup start? Please share it as YYYY-MM-DD.",
    });
    expect(result.exactMatches).toEqual([]);
    expect(result.alternatives).toEqual([]);
    expect(carSearchService.searchCars).not.toHaveBeenCalled();
  });

  it("returns a hard precondition prompt when drop-off date is invalid or before pickup", async () => {
    const fromDate = makeIsoDate(10);
    const toDate = makeIsoDate(8);

    const result = await service.searchVehiclesFromExtracted(
      {
        make: "Toyota",
        model: "Prado",
        from: fromDate,
        to: toDate,
      },
      "Looking for: black toyota prado",
    );

    expect(result.precondition).toEqual({
      missingField: "to",
      prompt: "Drop-off date cannot be before pickup date. Please share a valid drop-off date.",
    });
    expect(carSearchService.searchCars).not.toHaveBeenCalled();
  });

  it("returns a hard precondition prompt when pickup time format is invalid", async () => {
    const fromDate = makeIsoDate(10);

    const result = await service.searchVehiclesFromExtracted(
      {
        make: "Toyota",
        model: "Prado",
        from: fromDate,
        bookingType: "DAY",
        pickupTime: "25:99",
      },
      "Looking for: black toyota prado",
    );

    expect(result.precondition).toEqual({
      missingField: "pickupTime",
      prompt: "Please share pickup time in this format: 9:00 AM or 14:00.",
    });
    expect(carSearchService.searchCars).not.toHaveBeenCalled();
  });

  it("returns exact matches when at least one candidate fully matches requested attributes", async () => {
    const fromDate = makeIsoDate(2);

    carSearchService.searchCars.mockResolvedValue(
      buildSearchResponse([
        buildCar("car_exact_prado_black"),
        buildCar("car_other", { model: "Land Cruiser" }),
      ]),
    );

    const result = await service.searchVehiclesFromExtracted(
      {
        make: "Toyota",
        model: "Prado",
        color: "Black",
        from: fromDate,
      },
      "Looking for: black toyota prado",
    );

    expect(result.precondition).toBeNull();
    expect(result.exactMatches.map((option) => option.id)).toEqual(["car_exact_prado_black"]);
    expect(result.exactMatches[0]?.estimatedTotalInclVat).toBeGreaterThan(0);
    expect(result.alternatives).toHaveLength(0);
    expect(result.shouldClarifyBookingType).toBe(false);
  });

  it("returns ranked alternatives when no exact match exists", async () => {
    const fromDate = makeIsoDate(2);

    const pradoWhite = buildCar("car_prado_white", { color: "White" });
    const landCruiserBlack = buildCar("car_land_cruiser_black", {
      model: "Land Cruiser",
      color: "Black",
      dayRate: 75000,
    });
    const lexusBlack = buildCar("car_lexus_black", {
      make: "Lexus",
      model: "GX 460",
      color: "Black",
      dayRate: 70000,
    });

    carSearchService.searchCars.mockImplementation(async (query) => {
      if (query.make === "Toyota" && query.model === "Prado" && query.color === "Black") {
        return buildSearchResponse([]);
      }
      if (query.model === "Prado" && !query.color) {
        return buildSearchResponse([pradoWhite]);
      }
      if (query.color === "Black" && !query.model) {
        return buildSearchResponse([landCruiserBlack, lexusBlack]);
      }
      if (query.vehicleType === "SUV" && !query.color && !query.model) {
        return buildSearchResponse([landCruiserBlack, lexusBlack]);
      }
      if (query.make === "Toyota" && !query.model && !query.color) {
        return buildSearchResponse([landCruiserBlack]);
      }
      return buildSearchResponse([]);
    });

    const result = await service.searchVehiclesFromExtracted(
      {
        make: "Toyota",
        model: "Prado",
        color: "Black",
        vehicleType: "SUV",
        from: fromDate,
        bookingType: "NIGHT",
      },
      "Looking for: black toyota prado",
    );

    expect(result.exactMatches).toHaveLength(0);
    expect(result.alternatives[0]?.id).toBe("car_prado_white");
    expect(result.alternatives[0]?.reason).toBe("SAME_MODEL_DIFFERENT_COLOR");
    expect(result.alternatives[1]?.id).toBe("car_land_cruiser_black");
    expect(result.shouldClarifyBookingType).toBe(false);
  });

  it("labels fallback options as similar price range when no class/model/color match but price is close", async () => {
    const fromDate = makeIsoDate(2);

    const suvOne = buildCar("car_suv_one", {
      make: "Toyota",
      model: "Land Cruiser",
      color: "White",
      dayRate: 80000,
    });
    const suvTwo = buildCar("car_suv_two", {
      make: "Lexus",
      model: "GX 460",
      color: "Grey",
      dayRate: 74000,
    });
    const sedanNearPrice = buildCar("car_sedan_near_price", {
      make: "Mercedes",
      model: "C300",
      color: "Silver",
      vehicleType: "SEDAN",
      serviceTier: "EXECUTIVE",
      dayRate: 76000,
    });
    const farPrice = buildCar("car_far_price", {
      make: "BMW",
      model: "X7",
      color: "Blue",
      vehicleType: "LUXURY_SUV",
      serviceTier: "ULTRA_LUXURY",
      dayRate: 110000,
    });

    carSearchService.searchCars.mockImplementation(async (query) => {
      if (
        query.make === "Toyota" &&
        query.model === "Prado" &&
        query.color === "Black" &&
        query.vehicleType === "SUV"
      ) {
        return buildSearchResponse([]);
      }
      if (query.vehicleType === "SUV" && !query.make && !query.model) {
        return buildSearchResponse([suvOne, suvTwo, farPrice]);
      }
      if (query.make === "Toyota" && !query.model && !query.color) {
        return buildSearchResponse([suvOne]);
      }
      if (query.model === "Prado" && !query.color) {
        return buildSearchResponse([]);
      }
      if (query.color === "Black" && !query.model) {
        return buildSearchResponse([sedanNearPrice]);
      }
      return buildSearchResponse([sedanNearPrice, farPrice]);
    });

    const result = await service.searchVehiclesFromExtracted(
      {
        make: "Toyota",
        model: "Prado",
        color: "Black",
        vehicleType: "SUV",
        from: fromDate,
        bookingType: "NIGHT",
      },
      "Looking for: black toyota prado",
    );

    expect(result.exactMatches).toHaveLength(0);
    expect(result.alternatives.some((option) => option.reason === "SIMILAR_PRICE_RANGE")).toBe(
      true,
    );
  });

  it("throws timeout when car search exceeds timeout window", async () => {
    const fromDate = makeIsoDate(10);
    const toDate = makeIsoDate(12);

    vi.useFakeTimers();
    try {
      carSearchService.searchCars.mockImplementation(
        async () =>
          new Promise(() => {
            // Intentionally unresolved to trigger timeout handling.
          }),
      );

      const searchPromise = service.searchVehiclesFromExtracted(
        {
          make: "Toyota",
          model: "Prado",
          from: fromDate,
          to: toDate,
          bookingType: "DAY",
          pickupTime: "9:00 AM",
          pickupLocation: "Wheatbaker hotel, Ikoyi",
          dropoffLocation: "Wheatbaker hotel, Ikoyi",
        },
        "Looking for: Toyota Prado",
      );
      const rejectionAssertion = expect(searchPromise).rejects.toBeInstanceOf(
        WhatsAppOperationTimeoutException,
      );
      await vi.advanceTimersByTimeAsync(WHATSAPP_CAR_SEARCH_TIMEOUT_MS + 100);
      await rejectionAssertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
