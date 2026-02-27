import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiSearchService } from "../ai-search/ai-search.service";
import { CarSearchService } from "../car/car-search.service";
import type { CarSearchResponseDto, SearchCarDto } from "../car/dto/car-search.dto";
import { RatesService } from "../rates/rates.service";
import { WHATSAPP_AI_SEARCH_TIMEOUT_MS } from "./whatsapp-agent.const";
import {
  WhatsAppToolInputValidationException,
  WhatsAppToolNotEnabledException,
} from "./whatsapp-agent.error";
import { WhatsAppSearchSlotMemoryService } from "./whatsapp-search-slot-memory.service";
import { WhatsAppToolExecutorService } from "./whatsapp-tool-executor.service";

describe("WhatsAppToolExecutorService", () => {
  let moduleRef: TestingModule;
  let service: WhatsAppToolExecutorService;
  let aiSearchService: { search: ReturnType<typeof vi.fn> };
  let carSearchService: { searchCars: ReturnType<typeof vi.fn> };
  let searchSlotMemoryService: {
    mergeWithLatest: ReturnType<typeof vi.fn>;
    recordQuestionAsked: ReturnType<typeof vi.fn>;
    clearAskedQuestion: ReturnType<typeof vi.fn>;
  };
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

  beforeEach(async () => {
    aiSearchService = {
      search: vi.fn(),
    };
    carSearchService = {
      searchCars: vi.fn(),
    };
    searchSlotMemoryService = {
      mergeWithLatest: vi.fn().mockImplementation(async (_conversationId, latest) => ({
        extracted: latest,
        dialogState: {
          bookingTypeConfirmed: Boolean(latest.bookingType),
          lastAskedQuestionType: null,
          lastAskedAt: null,
        },
      })),
      recordQuestionAsked: vi.fn().mockResolvedValue(undefined),
      clearAskedQuestion: vi.fn().mockResolvedValue(undefined),
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
        WhatsAppToolExecutorService,
        {
          provide: AiSearchService,
          useValue: aiSearchService,
        },
        {
          provide: CarSearchService,
          useValue: carSearchService,
        },
        {
          provide: WhatsAppSearchSlotMemoryService,
          useValue: searchSlotMemoryService,
        },
        {
          provide: RatesService,
          useValue: ratesService,
        },
      ],
    }).compile();

    service = moduleRef.get(WhatsAppToolExecutorService);
  });

  it("returns no_intent when there is no message content", async () => {
    const result = await service.searchVehiclesFromMessage("  ");
    expect(result).toEqual({ kind: "no_intent" });
    expect(aiSearchService.search).not.toHaveBeenCalled();
  });

  it("executes search_vehicles tool input through the dispatcher", async () => {
    carSearchService.searchCars.mockResolvedValue(buildSearchResponse([buildCar("car_prado")]));

    const result = await service.execute("search_vehicles", {
      pickupDate: "2026-03-10",
      bookingType: "DAY",
      pickupTime: "9:00 AM",
      pickupLocation: "The George Hotel, Ikoyi",
      dropoffLocation: "The George Hotel, Ikoyi",
      vehicleModel: "Toyota Prado",
      vehicleColor: "Black",
      vehicleCategory: "SUV",
    });

    expect((result as { exactMatches?: Array<{ id: string }> }).exactMatches?.[0]?.id).toBe(
      "car_prado",
    );
  });

  it("rejects invalid tool payloads in dispatcher", async () => {
    await expect(
      service.execute("search_vehicles", { vehicleModel: "Toyota Prado" }),
    ).rejects.toBeInstanceOf(WhatsAppToolInputValidationException);
  });

  it("returns clear not-enabled error for non-search tools", async () => {
    await expect(
      service.execute("get_quote", {
        vehicleId: "car_1",
        pickupDate: "2026-03-10",
        bookingType: "DAY",
      }),
    ).rejects.toBeInstanceOf(WhatsAppToolNotEnabledException);
  });

  it("returns a hard precondition prompt when pickup date is missing", async () => {
    aiSearchService.search.mockResolvedValue({
      interpretation: "Looking for: black toyota prado",
      params: {},
      raw: {
        make: "Toyota",
        model: "Prado",
        color: "Black",
      },
    });

    const result = await service.searchVehiclesFromMessage("Need a black Prado");

    expect(result.kind).toBe("ask_precondition");
    const toolResult = result.kind === "ask_precondition" ? result.result : null;
    expect(toolResult?.precondition).toEqual({
      missingField: "from",
      prompt: "What date should pickup start? Please share it as YYYY-MM-DD.",
    });
    expect(toolResult?.exactMatches).toEqual([]);
    expect(toolResult?.alternatives).toEqual([]);
    expect(carSearchService.searchCars).not.toHaveBeenCalled();
  });

  it("merges extracted slots with existing conversation memory when conversation id is provided", async () => {
    aiSearchService.search.mockResolvedValue({
      interpretation: "Looking for: dates only",
      params: {},
      raw: {
        from: "2026-03-10",
        to: "2026-03-12",
      },
    });
    searchSlotMemoryService.mergeWithLatest.mockResolvedValue({
      extracted: {
        make: "Toyota",
        model: "Prado",
        color: "Black",
        from: "2026-03-10",
        to: "2026-03-12",
        pickupTime: "11:00 AM",
      },
      dialogState: {
        bookingTypeConfirmed: false,
        lastAskedQuestionType: null,
        lastAskedAt: null,
      },
    });
    carSearchService.searchCars.mockResolvedValue(buildSearchResponse([buildCar("car_merged")]));

    const result = await service.searchVehiclesFromMessage("tomorrow for 3 days", "conv_1");

    expect(searchSlotMemoryService.mergeWithLatest).toHaveBeenCalledWith("conv_1", {
      from: "2026-03-10",
      to: "2026-03-12",
    });
    expect(result.kind).toBe("ask_booking_clarification");
    const toolResult = result.kind === "ask_booking_clarification" ? result.result : null;
    expect(toolResult?.extracted.make).toBe("Toyota");
  });

  it("returns a hard precondition prompt when drop-off date is invalid or before pickup", async () => {
    aiSearchService.search.mockResolvedValue({
      interpretation: "Looking for: black toyota prado",
      params: {},
      raw: {
        make: "Toyota",
        model: "Prado",
        from: "2026-03-10",
        to: "2026-03-08",
      },
    });

    const result = await service.searchVehiclesFromMessage("Need Prado from Mar 10 to Mar 8");

    expect(result.kind).toBe("ask_precondition");
    const toolResult = result.kind === "ask_precondition" ? result.result : null;
    expect(toolResult?.precondition).toEqual({
      missingField: "to",
      prompt: "Drop-off date cannot be before pickup date. Please share a valid drop-off date.",
    });
    expect(carSearchService.searchCars).not.toHaveBeenCalled();
  });

  it("returns a hard precondition prompt when pickup time format is invalid", async () => {
    aiSearchService.search.mockResolvedValue({
      interpretation: "Looking for: black toyota prado",
      params: {},
      raw: {
        make: "Toyota",
        model: "Prado",
        from: "2026-03-10",
        bookingType: "DAY",
        pickupTime: "25:99",
      },
    });

    const result = await service.searchVehiclesFromMessage(
      "Need Prado on Mar 10 for daytime, pickup 25:99",
    );

    expect(result.kind).toBe("ask_precondition");
    const toolResult = result.kind === "ask_precondition" ? result.result : null;
    expect(toolResult?.precondition).toEqual({
      missingField: "pickupTime",
      prompt: "Please share pickup time in this format: 9:00 AM.",
    });
    expect(carSearchService.searchCars).not.toHaveBeenCalled();
  });

  it("returns exact matches when at least one candidate fully matches requested attributes", async () => {
    aiSearchService.search.mockResolvedValue({
      interpretation: "Looking for: black toyota prado",
      params: {},
      raw: {
        make: "Toyota",
        model: "Prado",
        color: "Black",
        from: "2026-03-02",
      },
    });

    carSearchService.searchCars.mockResolvedValue(
      buildSearchResponse([
        buildCar("car_exact_prado_black"),
        buildCar("car_other", { model: "Land Cruiser" }),
      ]),
    );

    const result = await service.searchVehiclesFromMessage("Need a black Prado tomorrow");

    expect(result.kind).toBe("ask_booking_clarification");
    const toolResult = result.kind === "ask_booking_clarification" ? result.result : null;
    expect(toolResult?.precondition).toBeNull();
    expect(toolResult?.exactMatches.map((option) => option.id)).toEqual(["car_exact_prado_black"]);
    expect(toolResult?.exactMatches[0]?.estimatedTotalInclVat).toBeGreaterThan(0);
    expect(toolResult?.alternatives).toHaveLength(0);
    expect(toolResult?.shouldClarifyBookingType).toBe(true);
  });

  it("returns ranked alternatives when no exact match exists", async () => {
    aiSearchService.search.mockResolvedValue({
      interpretation: "Looking for: black toyota prado",
      params: {},
      raw: {
        make: "Toyota",
        model: "Prado",
        color: "Black",
        vehicleType: "SUV",
        from: "2026-03-02",
        bookingType: "NIGHT",
      },
    });

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

    const result = await service.searchVehiclesFromMessage("Need a black Toyota Prado");

    expect(result.kind).toBe("show_options");
    const toolResult = result.kind === "show_options" ? result.result : null;
    expect(toolResult?.exactMatches).toHaveLength(0);
    expect(toolResult?.alternatives[0]?.id).toBe("car_prado_white");
    expect(toolResult?.alternatives[0]?.reason).toBe("SAME_MODEL_DIFFERENT_COLOR");
    expect(toolResult?.alternatives[1]?.id).toBe("car_land_cruiser_black");
    expect(toolResult?.shouldClarifyBookingType).toBe(false);
  });

  it("labels fallback options as similar price range when no class/model/color match but price is close", async () => {
    aiSearchService.search.mockResolvedValue({
      interpretation: "Looking for: black toyota prado",
      params: {},
      raw: {
        make: "Toyota",
        model: "Prado",
        color: "Black",
        vehicleType: "SUV",
        from: "2026-03-02",
        bookingType: "NIGHT",
      },
    });

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

    const result = await service.searchVehiclesFromMessage(
      "Need a black Toyota Prado tomorrow night",
    );

    expect(result.kind).toBe("show_options");
    const toolResult = result.kind === "show_options" ? result.result : null;
    expect(toolResult?.exactMatches).toHaveLength(0);
    expect(toolResult?.alternatives.some((option) => option.reason === "SIMILAR_PRICE_RANGE")).toBe(
      true,
    );
  });

  it("does not ask booking clarification again after explicit booking type confirmation", async () => {
    aiSearchService.search.mockResolvedValue({
      interpretation: "Looking for: day confirmation",
      params: {},
      raw: {
        bookingType: "DAY",
      },
    });
    searchSlotMemoryService.mergeWithLatest.mockResolvedValue({
      extracted: {
        make: "Toyota",
        vehicleType: "SUV",
        from: "2026-03-10",
        to: "2026-03-12",
        bookingType: "DAY",
        pickupTime: "9:00 AM",
        pickupLocation: "Wheatbaker hotel, Ikoyi",
        dropoffLocation: "Wheatbaker hotel, Ikoyi",
      },
      dialogState: {
        bookingTypeConfirmed: true,
        lastAskedQuestionType: "booking_clarification",
        lastAskedAt: "2026-03-09T10:00:00.000Z",
      },
    });
    carSearchService.searchCars.mockResolvedValue(buildSearchResponse([buildCar("car_confirmed")]));

    const result = await service.searchVehiclesFromMessage("DAY", "conv_confirmed");

    expect(result.kind).toBe("show_options");
    expect(searchSlotMemoryService.recordQuestionAsked).not.toHaveBeenCalled();
    expect(searchSlotMemoryService.clearAskedQuestion).toHaveBeenCalledWith("conv_confirmed");
  });

  it("returns error result when AI search times out", async () => {
    vi.useFakeTimers();
    aiSearchService.search.mockImplementation(
      async () =>
        new Promise(() => {
          // Intentionally unresolved to trigger timeout handling.
        }),
    );

    const searchPromise = service.searchVehiclesFromMessage("Need an SUV tomorrow");
    await vi.advanceTimersByTimeAsync(WHATSAPP_AI_SEARCH_TIMEOUT_MS + 100);
    const result = await searchPromise;

    expect(result.kind).toBe("error");
    vi.useRealTimers();
  });
});
