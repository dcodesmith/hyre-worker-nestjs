import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
    }).compile();

    return module.get<GooglePlacesService>(GooglePlacesService);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    service = await createService("test-api-key");
  });

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
    expect(result.normalizedAddress).toBeUndefined();
    expect(result.placeId).toBeUndefined();
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
});
