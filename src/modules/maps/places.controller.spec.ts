import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GooglePlacesService } from "./google-places.service";
import { PlacesController } from "./places.controller";
import { PlacesThrottlerGuard } from "./places-throttler.guard";
import { PLACES_THROTTLE_CONFIG } from "./places-throttling.config";

describe("PlacesController", () => {
  let controller: PlacesController;
  let googlePlacesService: {
    autocompleteAddress: ReturnType<typeof vi.fn>;
    resolvePlace: ReturnType<typeof vi.fn>;
    validateAddress: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    googlePlacesService = {
      autocompleteAddress: vi.fn(),
      resolvePlace: vi.fn(),
      validateAddress: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: PLACES_THROTTLE_CONFIG.name,
            ttl: PLACES_THROTTLE_CONFIG.ttlMs,
            limit: PLACES_THROTTLE_CONFIG.limits.autocomplete,
          },
        ]),
      ],
      controllers: [PlacesController],
      providers: [
        PlacesThrottlerGuard,
        { provide: GooglePlacesService, useValue: googlePlacesService },
      ],
    }).compile();

    controller = module.get<PlacesController>(PlacesController);
  });

  it("returns mapped autocomplete suggestions", async () => {
    googlePlacesService.autocompleteAddress.mockResolvedValue({
      suggestions: [
        {
          placeId: "place_eko_hotel",
          description: "Eko Hotel, Victoria Island, Lagos",
          types: ["lodging", "point_of_interest"],
        },
      ],
    });

    const result = await controller.autocompleteAddress({
      input: "Eko",
      sessionToken: "session-token-1",
      limit: 4,
    });

    expect(googlePlacesService.autocompleteAddress).toHaveBeenCalledWith("Eko", {
      limit: 4,
      sessionToken: "session-token-1",
    });
    expect(result).toEqual({
      suggestions: [
        {
          placeId: "place_eko_hotel",
          description: "Eko Hotel, Victoria Island, Lagos",
          types: ["lodging", "point_of_interest"],
        },
      ],
    });
  });

  it("returns degraded metadata when autocomplete upstream fails", async () => {
    googlePlacesService.autocompleteAddress.mockResolvedValue({
      suggestions: [],
      meta: {
        degraded: true,
      },
    });

    const result = await controller.autocompleteAddress({
      input: "Lekki",
      limit: 4,
    });

    expect(result).toEqual({
      suggestions: [],
      meta: {
        degraded: true,
      },
    });
  });

  it("resolves selected placeId into normalized output", async () => {
    googlePlacesService.resolvePlace.mockResolvedValue({
      placeId: "place_eko_hotel",
      address: "Eko Hotel & Suites, Victoria Island",
      types: ["lodging", "point_of_interest"],
    });

    const result = await controller.resolvePlace({
      placeId: "place_eko_hotel",
      sessionToken: "session-token-1",
    });

    expect(googlePlacesService.resolvePlace).toHaveBeenCalledWith("place_eko_hotel", {
      sessionToken: "session-token-1",
    });
    expect(result).toEqual({
      placeId: "place_eko_hotel",
      address: "Eko Hotel & Suites, Victoria Island",
      types: ["lodging", "point_of_interest"],
    });
  });

  it("returns strict validation response fields", async () => {
    googlePlacesService.validateAddress.mockResolvedValue({
      isValid: false,
      normalizedAddress: null,
      placeId: null,
      failureReason: "AREA_ONLY",
    });

    const result = await controller.validatePlace({ input: "Lekki" });

    expect(googlePlacesService.validateAddress).toHaveBeenCalledWith("Lekki");
    expect(result).toEqual({
      isValid: false,
      normalizedAddress: null,
      placeId: null,
      failureReason: "AREA_ONLY",
    });
  });

  it("applies PlacesThrottlerGuard on all places endpoints", () => {
    const autocompleteGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      PlacesController.prototype.autocompleteAddress,
    ) as unknown[];
    const resolveGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      PlacesController.prototype.resolvePlace,
    ) as unknown[];
    const validateGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      PlacesController.prototype.validatePlace,
    ) as unknown[];

    expect(autocompleteGuards).toContain(PlacesThrottlerGuard);
    expect(resolveGuards).toContain(PlacesThrottlerGuard);
    expect(validateGuards).toContain(PlacesThrottlerGuard);
  });
});
