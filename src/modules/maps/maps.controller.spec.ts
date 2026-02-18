import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MapsController } from "./maps.controller";
import { MapsService } from "./maps.service";

describe("MapsController", () => {
  let controller: MapsController;
  let mapsService: MapsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MapsController],
      providers: [
        {
          provide: MapsService,
          useValue: {
            calculateAirportTripDuration: vi.fn(),
            calculateDriveTime: vi.fn(),
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

  it("calculates trip duration between custom origin and destination", async () => {
    vi.mocked(mapsService.calculateDriveTime).mockResolvedValueOnce({
      durationMinutes: 20,
      distanceMeters: 8000,
      isEstimate: false,
    });

    const result = await controller.calculateTripDuration({
      origin: "Lekki, Lagos",
      destination: "Victoria Island, Lagos",
    });

    expect(mapsService.calculateDriveTime).toHaveBeenCalledWith(
      "Lekki, Lagos",
      "Victoria Island, Lagos",
    );
    expect(result).toEqual({
      durationMinutes: 20,
      distanceMeters: 8000,
      isEstimate: false,
    });
  });
});
