import { HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAxiosErrorWithRequest,
  createAxiosErrorWithResponse,
  createMockAxiosInstance,
  createMockHttpClientService,
} from "../http-client/http-client.fixtures";
import { HttpClientService } from "../http-client/http-client.service";
import { MapsService } from "./maps.service";

describe("MapsService", () => {
  let service: MapsService;
  let mockHttpClient: ReturnType<typeof createMockAxiosInstance>;

  const createService = async (apiKey: string | undefined) => {
    const mockConfigService = {
      get: vi.fn((key: string) => {
        if (key === "GOOGLE_DISTANCE_MATRIX_API_KEY") return apiKey;
        return undefined;
      }),
    };

    mockHttpClient = createMockAxiosInstance();
    const mockHttpClientService = createMockHttpClientService(mockHttpClient);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MapsService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: HttpClientService, useValue: mockHttpClientService },
      ],
    }).compile();

    return module.get<MapsService>(MapsService);
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("MapsService", () => {
    beforeEach(async () => {
      service = await createService("test-api-key");
    });

    describe("calculateAirportTripDuration", () => {
      it("should calculate drive time from airport to destination", async () => {
        mockHttpClient.post.mockResolvedValueOnce({
          data: {
            routes: [
              {
                duration: "3600s",
                distanceMeters: 25000,
              },
            ],
          },
        });

        const result = await service.calculateAirportTripDuration("Victoria Island, Lagos");

        expect(result.durationMinutes).toBe(60);
        expect(result.distanceMeters).toBe(25000);
        expect(result.isEstimate).toBe(false);

        expect(mockHttpClient.post).toHaveBeenCalledWith(
          "https://routes.googleapis.com/directions/v2:computeRoutes",
          expect.objectContaining({
            origin: expect.objectContaining({
              location: expect.objectContaining({
                latLng: {
                  latitude: 6.5774,
                  longitude: 3.3212,
                },
              }),
            }),
            destination: expect.objectContaining({
              address: "Victoria Island, Lagos",
            }),
          }),
        );
      });

      it("should round up duration to nearest minute", async () => {
        mockHttpClient.post.mockResolvedValueOnce({
          data: {
            routes: [
              {
                duration: "3601s", // 60 min 1 sec -> should round to 61
                distanceMeters: 25000,
              },
            ],
          },
        });

        const result = await service.calculateAirportTripDuration("Victoria Island, Lagos");

        expect(result.durationMinutes).toBe(61);
      });

      it("should return fallback on API error", async () => {
        const axiosError = createAxiosErrorWithResponse(HttpStatus.INTERNAL_SERVER_ERROR, {
          message: "Internal server error",
        });
        mockHttpClient.post.mockRejectedValueOnce(axiosError);

        const result = await service.calculateAirportTripDuration("Victoria Island, Lagos");

        expect(result.durationMinutes).toBe(180);
        expect(result.isEstimate).toBe(true);
      });

      it("should return fallback when no routes found", async () => {
        mockHttpClient.post.mockResolvedValueOnce({
          data: { routes: [] },
        });

        const result = await service.calculateAirportTripDuration("Invalid Address");

        expect(result.durationMinutes).toBe(180);
        expect(result.isEstimate).toBe(true);
      });

      it("should return fallback on network error", async () => {
        const axiosError = createAxiosErrorWithRequest("Network error");
        mockHttpClient.post.mockRejectedValueOnce(axiosError);

        const result = await service.calculateAirportTripDuration("Victoria Island, Lagos");

        expect(result.durationMinutes).toBe(180);
        expect(result.isEstimate).toBe(true);
      });
    });
  });
});
