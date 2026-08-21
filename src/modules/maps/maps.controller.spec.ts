import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MapsController } from "./maps.controller";
import { MapsService } from "./maps.service";
import { TripDurationThrottlerGuard } from "./maps-throttler.guard";
import { TRIP_DURATION_THROTTLE_CONFIG } from "./maps-throttling.config";

describe("MapsController", () => {
  let controller: MapsController;
  let mapsService: MapsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: TRIP_DURATION_THROTTLE_CONFIG.name,
            ttl: TRIP_DURATION_THROTTLE_CONFIG.ttlMs,
            limit: TRIP_DURATION_THROTTLE_CONFIG.limit,
          },
        ]),
      ],
      controllers: [MapsController],
      providers: [
        TripDurationThrottlerGuard,
        {
          provide: MapsService,
          useValue: {
            calculateAirportTripDuration: vi.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<MapsController>(MapsController);
    mapsService = module.get<MapsService>(MapsService);
  });

  it("calculates trip duration from airport when origin is omitted", async () => {
    vi.mocked(mapsService.calculateAirportTripDuration).mockResolvedValueOnce({
      durationMinutes: 45,
      distanceMeters: 23000,
      isEstimate: false,
    });

    const result = await controller.calculateTripDuration({
      destination: "Victoria Island, Lagos",
    });

    expect(mapsService.calculateAirportTripDuration).toHaveBeenCalledWith("Victoria Island, Lagos");
    expect(result).toEqual({
      durationMinutes: 45,
      distanceMeters: 23000,
      isEstimate: false,
    });
  });

  it("applies TripDurationThrottlerGuard on calculate-trip-duration", () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      MapsController.prototype.calculateTripDuration,
    );

    expect(guards).toContain(TripDurationThrottlerGuard);
  });
});
