import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AxiosInstance } from "axios";
import type { EnvConfig } from "src/config/env.config";
import { HttpClientService } from "../http-client/http-client.service";
import { LAGOS_VIEWPORT_BOUNDS } from "./maps.const";
import type {
  AddressLookupResult,
  PlaceDetailsResponse,
  PlaceSuggestion,
  PlacesAutocompleteNewResponse,
} from "./maps.interface";

@Injectable()
export class GooglePlacesService {
  private readonly logger = new Logger(GooglePlacesService.name);
  private readonly apiKey: string | undefined;
  private readonly maxSuggestions = 4;
  private readonly autocompleteUrl = "https://places.googleapis.com/v1/places:autocomplete";
  private readonly placeDetailsBaseUrl = "https://places.googleapis.com/v1/places";
  private readonly httpClient: AxiosInstance;
  private readonly areaPlaceTypes = new Set([
    "locality",
    "sublocality",
    "sublocality_level_1",
    "sublocality_level_2",
    "sublocality_level_3",
    "sublocality_level_4",
    "sublocality_level_5",
    "neighborhood",
    "administrative_area_level_1",
    "administrative_area_level_2",
    "administrative_area_level_3",
    "postal_town",
  ]);
  private readonly precisePlaceTypes = new Set([
    "street_address",
    "premise",
    "subpremise",
    "establishment",
    "point_of_interest",
    "airport",
    "lodging",
  ]);

  constructor(
    private readonly configService: ConfigService<EnvConfig>,
    private readonly httpClientService: HttpClientService,
  ) {
    this.apiKey = this.configService.get("GOOGLE_DISTANCE_MATRIX_API_KEY", { infer: true });
    this.httpClient = this.httpClientService.createClient({
      timeout: 10000,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask":
          "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.types",
      },
      serviceName: "GooglePlaces",
    });
  }

  async validateAddressWithSuggestions(input: string): Promise<AddressLookupResult> {
    const query = input.trim();
    if (!query) {
      return { isValid: false, suggestions: [] };
    }

    const suggestions = await this.fetchAutocompleteSuggestions(query);
    if (suggestions.length === 0) {
      return { isValid: false, suggestions: [], failureReason: "NO_MATCH" };
    }

    const topMatch = suggestions[0];
    const details = topMatch?.placeId ? await this.fetchPlaceDetails(topMatch.placeId) : null;

    if (details && this.isAreaOnlyFromPlaceDetails(details)) {
      return {
        isValid: false,
        suggestions: [],
        failureReason: "AREA_ONLY",
      };
    }

    if (details && this.isSpecificAddressFromPlaceDetails(details)) {
      return {
        isValid: true,
        normalizedAddress: details.formattedAddress ?? topMatch?.description,
        placeId: topMatch?.placeId,
        suggestions,
      };
    }

    if (!details && this.isAreaOnlyInput(query, suggestions)) {
      return {
        isValid: false,
        suggestions: [],
        failureReason: "AREA_ONLY",
      };
    }

    const isValid =
      this.isSpecificAddressQuery(query) &&
      this.isLikelyExactAddressMatch(query, topMatch?.description ?? "");

    return {
      isValid,
      normalizedAddress: isValid ? topMatch?.description : undefined,
      placeId: isValid ? topMatch?.placeId : undefined,
      suggestions: isValid ? suggestions : suggestions.slice(0, this.maxSuggestions),
      failureReason: isValid ? undefined : "AMBIGUOUS",
    };
  }

  private async fetchAutocompleteSuggestions(query: string): Promise<PlaceSuggestion[]> {
    try {
      const { data } = await this.httpClient.post<PlacesAutocompleteNewResponse>(
        this.autocompleteUrl,
        {
          input: query,
          includedRegionCodes: ["ng"],
          locationRestriction: {
            rectangle: LAGOS_VIEWPORT_BOUNDS,
          },
          includeQueryPredictions: false,
        },
      );

      return (data.suggestions ?? [])
        .map((suggestion) => suggestion.placePrediction)
        .filter((prediction): prediction is NonNullable<typeof prediction> => !!prediction)
        .filter((prediction) => prediction.text?.text && prediction.placeId)
        .slice(0, this.maxSuggestions)
        .map((prediction) => ({
          placeId: prediction.placeId,
          description: prediction.text?.text ?? "",
          types: prediction.types ?? [],
        }));
    } catch (error) {
      const info = this.httpClientService.handleError(
        error,
        "fetchAutocompleteSuggestions",
        "GooglePlaces",
      );
      this.logger.warn("Autocomplete suggestions failed", {
        query,
        status: info.status,
        error: info.message,
      });
      return [];
    }
  }

  private async fetchPlaceDetails(placeId: string): Promise<PlaceDetailsResponse | null> {
    try {
      const { data } = await this.httpClient.get<PlaceDetailsResponse>(
        `${this.placeDetailsBaseUrl}/${encodeURIComponent(placeId)}`,
        {
          headers: {
            "X-Goog-FieldMask":
              "id,types,formattedAddress,addressComponents,displayName.text,displayName.languageCode",
          },
        },
      );
      return data ?? null;
    } catch (error) {
      const info = this.httpClientService.handleError(error, "fetchPlaceDetails", "GooglePlaces");
      this.logger.warn("Place details fetch failed", {
        placeId,
        status: info.status,
        error: info.message,
      });
      return null;
    }
  }

  private isLikelyExactAddressMatch(input: string, topSuggestion: string): boolean {
    const normalize = (value: string) =>
      value
        .trim()
        .toLowerCase()
        .replaceAll(/[^\w\s]/g, " ")
        .replaceAll(/\s+/g, " ");

    const normalizedInput = normalize(input);
    const normalizedSuggestion = normalize(topSuggestion);
    if (!normalizedInput || !normalizedSuggestion) {
      return false;
    }

    return (
      normalizedSuggestion === normalizedInput ||
      normalizedSuggestion.includes(normalizedInput) ||
      normalizedInput.includes(normalizedSuggestion)
    );
  }

  /**
   * Require concrete pickup detail:
   * - a named place (hotel/airport/etc), OR
   * - a street-style address that includes a number.
   */
  private isSpecificAddressQuery(input: string): boolean {
    const normalized = input.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    const hasVenueKeyword =
      /\b(hotel|airport|mall|hospital|plaza|tower|estate|school|university|resort|lounge|terminal)\b/.test(
        normalized,
      );
    if (hasVenueKeyword) {
      return true;
    }

    const hasStreetToken =
      /\b(street|st|road|rd|avenue|ave|close|crescent|lane|drive|boulevard|way|expressway)\b/.test(
        normalized,
      );
    const hasBuildingNumber = /\b\d+[a-z]?\b/.test(normalized);

    return hasStreetToken && hasBuildingNumber;
  }

  private isAreaOnlyInput(input: string, suggestions: PlaceSuggestion[]): boolean {
    const tokens = input
      .trim()
      .toLowerCase()
      .replaceAll(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0 || tokens.length > 2) {
      return false;
    }

    if (this.isSpecificAddressQuery(input)) {
      return false;
    }

    const topSuggestions = suggestions.slice(0, 3);
    if (topSuggestions.length === 0) {
      return false;
    }

    const allLookAreaLike = topSuggestions.every((suggestion) =>
      (suggestion.types ?? []).some((type) => this.areaPlaceTypes.has(type)),
    );
    const anyLookPrecise = topSuggestions.some((suggestion) =>
      (suggestion.types ?? []).some((type) => this.precisePlaceTypes.has(type)),
    );

    return allLookAreaLike && !anyLookPrecise;
  }

  private isAreaOnlyFromPlaceDetails(details: PlaceDetailsResponse): boolean {
    const componentTypes = new Set(
      (details.addressComponents ?? []).flatMap((component) => component.types ?? []),
    );
    const hasStreetNumber = componentTypes.has("street_number");
    const hasRoute = componentTypes.has("route");
    if (hasStreetNumber || hasRoute) {
      return false;
    }

    const placeTypes = new Set(details.types ?? []);
    const allTypes = new Set([...placeTypes, ...componentTypes]);
    const hasAreaSignals = [...allTypes].some((type) => this.areaPlaceTypes.has(type));
    const hasGeoOnlyTopType =
      placeTypes.has("island") ||
      placeTypes.has("natural_feature") ||
      placeTypes.has("locality") ||
      placeTypes.has("sublocality") ||
      placeTypes.has("postal_town");
    const hasVenueTopType =
      placeTypes.has("lodging") ||
      placeTypes.has("airport") ||
      placeTypes.has("point_of_interest") ||
      placeTypes.has("premise") ||
      placeTypes.has("subpremise");
    const hasPreciseSignals = [...allTypes].some(
      (type) => this.precisePlaceTypes.has(type) && type !== "establishment",
    );

    return hasGeoOnlyTopType || (hasAreaSignals && !hasVenueTopType && !hasPreciseSignals);
  }

  private isSpecificAddressFromPlaceDetails(details: PlaceDetailsResponse): boolean {
    const componentTypes = new Set(
      (details.addressComponents ?? []).flatMap((component) => component.types ?? []),
    );
    const hasStreetNumber = componentTypes.has("street_number");
    const hasRoute = componentTypes.has("route");
    if (hasStreetNumber && hasRoute) {
      return true;
    }

    const placeTypes = new Set(details.types ?? []);
    const isAirport = placeTypes.has("airport");

    return isAirport && !!details.formattedAddress;
  }
}
