import { HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  createAxiosErrorWithResponse,
  createMockAxiosInstance,
  createMockHttpClientService,
} from "../http-client/http-client.fixtures";
import { HttpClientService } from "../http-client/http-client.service";
import { GooglePlacesService } from "./google-places.service";

describe("GooglePlacesService", () => {
  let service: GooglePlacesService;
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
        GooglePlacesService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: HttpClientService, useValue: mockHttpClientService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    return module.get<GooglePlacesService>(GooglePlacesService);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    service = await createService("test-api-key");
  });

  describe("autocompleteAddress", () => {
    it("returns mapped autocomplete suggestions with requested limit", async () => {
      mockHttpClient.post.mockResolvedValueOnce({
        data: {
          suggestions: [
            {
              placePrediction: {
                placeId: "place_1",
                text: { text: "Eko Hotel, Victoria Island, Lagos" },
                types: ["lodging", "point_of_interest"],
              },
            },
            {
              placePrediction: {
                placeId: "place_2",
                text: { text: "Eko Atlantic City, Lagos" },
                types: ["point_of_interest"],
              },
            },
            {
              placePrediction: {
                placeId: "place_3",
                text: { text: "Eko Bridge, Lagos" },
                types: ["route"],
              },
            },
          ],
        },
      });

      const result = await service.autocompleteAddress("Eko", {
        limit: 2,
        sessionToken: "token-1",
      });

      expect(result).toEqual({
        suggestions: [
          {
            placeId: "place_1",
            description: "Eko Hotel, Victoria Island, Lagos",
            types: ["lodging", "point_of_interest"],
          },
          {
            placeId: "place_2",
            description: "Eko Atlantic City, Lagos",
            types: ["point_of_interest"],
          },
        ],
      });
      expect(mockHttpClient.post).toHaveBeenCalledWith(
        "https://places.googleapis.com/v1/places:autocomplete",
        expect.objectContaining({
          input: "Eko",
          sessionToken: "token-1",
        }),
      );
    });

    it("returns empty degraded response on upstream failure", async () => {
      mockHttpClient.post.mockRejectedValueOnce(
        createAxiosErrorWithResponse(HttpStatus.BAD_GATEWAY, {
          message: "Upstream unavailable",
        }),
      );

      const result = await service.autocompleteAddress("Lekki", { limit: 4 });

      expect(result).toEqual({
        suggestions: [],
        meta: {
          degraded: true,
        },
      });
    });
  });

  describe("resolvePlace", () => {
    it("reconstructs specific street address when formattedAddress is too generic", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          id: "place_wheatbaker",
          types: ["lodging", "point_of_interest"],
          businessStatus: "OPERATIONAL",
          displayName: { text: "The Wheatbaker" },
          formattedAddress: "Lawrence Road, Lagos, Nigeria",
          addressComponents: [
            { longText: "4", shortText: "4", types: ["street_number"] },
            { longText: "Lawrence Road", shortText: "Lawrence Rd", types: ["route"] },
            { longText: "Ikoyi", shortText: "Ikoyi", types: ["neighborhood", "political"] },
            { longText: "Lagos", shortText: "Lagos", types: ["locality", "political"] },
          ],
        },
      });

      const result = await service.resolvePlace("place_wheatbaker", { sessionToken: "token-1" });

      expect(result).toEqual({
        placeId: "place_wheatbaker",
        address: "The Wheatbaker, 4 Lawrence Rd, Ikoyi, Lagos",
        types: ["lodging", "point_of_interest"],
      });
      expect(mockHttpClient.get).toHaveBeenCalledWith(
        "https://places.googleapis.com/v1/places/place_wheatbaker",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Goog-FieldMask": expect.stringContaining(
              "displayName,formattedAddress,businessStatus,addressComponents",
            ),
          }),
          params: {
            sessionToken: "token-1",
          },
        }),
      );
    });

    it("returns degraded unresolved output when upstream details fail", async () => {
      mockHttpClient.get.mockRejectedValueOnce(
        createAxiosErrorWithResponse(HttpStatus.BAD_GATEWAY, {
          message: "Upstream unavailable",
        }),
      );

      const result = await service.resolvePlace("place_missing");

      expect(result).toEqual({
        placeId: "place_missing",
        address: null,
        types: [],
        meta: {
          degraded: true,
        },
      });
    });

    it("returns cleaned formattedAddress without business prefix when businessStatus is missing", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          id: "place_street",
          types: ["street_address"],
          formattedAddress: "12 Glover Road, Ikoyi, Lagos, Nigeria",
        },
      });

      const result = await service.resolvePlace("place_street");

      expect(result).toEqual({
        placeId: "place_street",
        address: "12 Glover Road, Ikoyi",
        types: ["street_address"],
      });
    });

    it("uses specific displayName with area tail when formattedAddress is area-only", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          id: "place_gerrard_6",
          types: ["street_address"],
          displayName: { text: "6 Gerrard Road" },
          formattedAddress: "Ikoyi, Lagos, Nigeria",
          addressComponents: [
            { longText: "Ikoyi", shortText: "Ikoyi", types: ["neighborhood", "political"] },
            { longText: "Lagos", shortText: "Lagos", types: ["locality", "political"] },
          ],
        },
      });

      const result = await service.resolvePlace("place_gerrard_6");

      expect(result).toEqual({
        placeId: "place_gerrard_6",
        address: "6 Gerrard Road, Ikoyi, Lagos",
        types: ["street_address"],
      });
    });
  });

  describe("validateAddress", () => {
    it("marks area-only input as invalid even when autocomplete returns a match", async () => {
      mockHttpClient.post.mockResolvedValueOnce({
        data: {
          suggestions: [
            {
              placePrediction: {
                placeId: "place_ikoyi",
                text: { text: "Ikoyi, Lagos, Nigeria" },
                types: ["neighborhood", "political"],
              },
            },
            {
              placePrediction: {
                placeId: "place_obalende",
                text: { text: "Obalende, Lagos, Nigeria" },
                types: ["sublocality_level_1", "political"],
              },
            },
          ],
        },
      });
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          id: "place_ikoyi",
          types: ["island", "natural_feature", "establishment"],
          formattedAddress: "Ikoyi, Lagos 106104, Lagos, Nigeria",
          addressComponents: [
            { longText: "Ikoyi", types: ["island", "natural_feature", "establishment"] },
            { longText: "Ikoyi", types: ["neighborhood", "political"] },
            { longText: "Lagos", types: ["locality", "political"] },
            { longText: "Eti Osa", types: ["administrative_area_level_2", "political"] },
            { longText: "Lagos", types: ["administrative_area_level_1", "political"] },
            { longText: "Nigeria", types: ["country", "political"] },
          ],
        },
      });

      const result = await service.validateAddress("Ikoyi");

      expect(result.isValid).toBe(false);
      expect(result.normalizedAddress).toBeNull();
      expect(result.placeId).toBeNull();
      expect(result.failureReason).toBe("AREA_ONLY");
    });

    it("accepts numbered street addresses as valid", async () => {
      mockHttpClient.post.mockResolvedValueOnce({
        data: {
          suggestions: [
            {
              placePrediction: {
                placeId: "place_glover_12",
                text: { text: "12 Glover Road, Ikoyi, Lagos, Nigeria" },
                types: ["street_address"],
              },
            },
          ],
        },
      });
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          id: "place_glover_12",
          types: ["street_address"],
          formattedAddress: "12 Glover Road, Ikoyi, Lagos, Nigeria",
          addressComponents: [
            { longText: "12", types: ["street_number"] },
            { longText: "Glover Road", types: ["route"] },
            { longText: "Ikoyi", types: ["neighborhood", "political"] },
          ],
        },
      });

      const result = await service.validateAddress("12 Glover Road Ikoyi");

      expect(result.isValid).toBe(true);
      expect(result.normalizedAddress).toBe("12 Glover Road, Ikoyi, Lagos, Nigeria");
      expect(result.placeId).toBe("place_glover_12");
    });

    it("marks route-only address as area-only (no street number)", async () => {
      mockHttpClient.post.mockResolvedValueOnce({
        data: {
          suggestions: [
            {
              placePrediction: {
                placeId: "place_glover_road",
                text: { text: "Glover Road, Ikoyi, Lagos, Nigeria" },
                types: ["route"],
              },
            },
          ],
        },
      });
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          id: "place_glover_road",
          types: ["route"],
          formattedAddress: "Glover Road, Ikoyi, Lagos, Nigeria",
          addressComponents: [
            { longText: "Glover Road", types: ["route"] },
            { longText: "Ikoyi", types: ["neighborhood", "political"] },
            { longText: "Lagos", types: ["locality", "political"] },
          ],
        },
      });

      const result = await service.validateAddress("Glover Road Ikoyi");

      expect(result.isValid).toBe(false);
      expect(result.failureReason).toBe("AREA_ONLY");
    });

    it("accepts venue address when place details include street number and route", async () => {
      mockHttpClient.post.mockResolvedValueOnce({
        data: {
          suggestions: [
            {
              placePrediction: {
                placeId: "place_wheatbaker",
                text: { text: "The Wheatbaker Hotel, Ikoyi, Lagos" },
                types: ["lodging", "establishment"],
              },
            },
          ],
        },
      });
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          id: "place_wheatbaker",
          types: ["hotel", "lodging", "point_of_interest", "establishment"],
          formattedAddress: "30 Lugard Ave, Ikoyi, Lagos 106104, Lagos, Nigeria",
          addressComponents: [
            { longText: "30", types: ["street_number"] },
            { longText: "Lugard Avenue", types: ["route"] },
            { longText: "Ikoyi", types: ["neighborhood", "political"] },
            { longText: "Lagos", types: ["locality", "political"] },
          ],
        },
      });

      const result = await service.validateAddress("Wheatbaker Hotel Ikoyi");

      expect(result.isValid).toBe(true);
      expect(result.normalizedAddress).toBe("30 Lugard Ave, Ikoyi, Lagos 106104, Lagos, Nigeria");
      expect(result.placeId).toBe("place_wheatbaker");
    });

    it("returns NO_MATCH when autocomplete fails upstream", async () => {
      mockHttpClient.post.mockRejectedValueOnce(
        createAxiosErrorWithResponse(HttpStatus.BAD_GATEWAY, {
          message: "Autocomplete failed",
        }),
      );

      const result = await service.validateAddress("Lekki");

      expect(result).toEqual({
        isValid: false,
        normalizedAddress: null,
        placeId: null,
        failureReason: "NO_MATCH",
      });
    });

    it("deduplicates repeated strict validation calls for same input", async () => {
      mockHttpClient.post.mockResolvedValueOnce({
        data: {
          suggestions: [
            {
              placePrediction: {
                placeId: "place_glover_12",
                text: { text: "12 Glover Road, Ikoyi, Lagos, Nigeria" },
                types: ["street_address"],
              },
            },
          ],
        },
      });
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          id: "place_glover_12",
          types: ["street_address"],
          formattedAddress: "12 Glover Road, Ikoyi, Lagos, Nigeria",
          addressComponents: [
            { longText: "12", types: ["street_number"] },
            { longText: "Glover Road", types: ["route"] },
          ],
        },
      });

      const first = await service.validateAddress("12 Glover Road Ikoyi");
      const second = await service.validateAddress("12 Glover Road Ikoyi");

      expect(first).toEqual(second);
      expect(mockHttpClient.post).toHaveBeenCalledTimes(1);
      expect(mockHttpClient.get).toHaveBeenCalledTimes(1);
    });
  });
});
