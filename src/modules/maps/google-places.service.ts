import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AxiosInstance } from "axios";
import { PinoLogger } from "nestjs-pino";
import type { EnvConfig } from "src/config/env.config";
import { HttpClientService } from "../http-client/http-client.service";
import { LAGOS_VIEWPORT_BOUNDS } from "./maps.const";
import type {
  AddressLookupResult,
  PlaceDetailsResponse,
  PlaceSuggestion,
  PlacesAutocompleteNewResponse,
  PlacesAutocompleteResponse,
  ResolvePlaceResponse,
} from "./maps.interface";

@Injectable()
export class GooglePlacesService {
  private readonly apiKey: string | undefined;
  private readonly maxSuggestions = 4;
  private readonly maxAllowedSuggestions = 8;
  private readonly validationCacheTtlMs = 30 * 1000;
  private readonly autocompleteUrl = "https://places.googleapis.com/v1/places:autocomplete";
  private readonly placeDetailsBaseUrl = "https://places.googleapis.com/v1/places";
  private readonly httpClient: AxiosInstance;
  private readonly validationResultCache = new Map<
    string,
    { expiresAt: number; result: AddressLookupResult }
  >();
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
    private readonly logger: PinoLogger,
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

    this.logger.setContext(GooglePlacesService.name);
  }

  async autocompleteAddress(
    input: string,
    options?: { limit?: number; sessionToken?: string },
  ): Promise<PlacesAutocompleteResponse> {
    const query = input.trim();

    const { suggestions, degraded } = await this.fetchAutocompleteSuggestions(query, {
      limit: this.resolveSuggestionLimit(options?.limit),
      sessionToken: options?.sessionToken,
    });

    this.logger.debug(
      {
        operation: "autocomplete",
        queryLength: query.length,
        suggestions,
        suggestionsCount: suggestions.length,
        degraded,
      },
      "Places autocomplete completed",
    );
    return degraded ? { suggestions, meta: { degraded: true } } : { suggestions };
  }

  async resolvePlace(
    placeId: string,
    options?: { sessionToken?: string },
  ): Promise<ResolvePlaceResponse> {
    const normalizedPlaceId = placeId.trim();
    const { details, degraded } = await this.fetchPlaceDetails(normalizedPlaceId, {
      sessionToken: options?.sessionToken,
    });

    if (!details) {
      this.logger.warn(
        {
          operation: "resolve",
          placeIdSuffix: normalizedPlaceId.slice(-6),
          degraded,
        },
        "Place resolution returned no details",
      );
      return {
        placeId: normalizedPlaceId,
        address: null,
        types: [],
        ...(degraded && {
          meta: {
            degraded: true,
          },
        }),
      };
    }

    const address = this.formatResolvedAddress(details);

    this.logger.debug(
      {
        operation: "resolve",
        placeIdSuffix: normalizedPlaceId.slice(-6),
        hasAddress: !!address,
        degraded,
      },
      "Place resolution completed",
    );
    return {
      placeId: details.id ?? normalizedPlaceId,
      address,
      types: details.types ?? [],
      ...(degraded && {
        meta: {
          degraded: true,
        },
      }),
    };
  }

  async validateAddress(
    input: string,
    options?: { sessionToken?: string },
  ): Promise<AddressLookupResult> {
    const query = input.trim();
    if (!query) {
      return {
        isValid: false,
        normalizedAddress: null,
        placeId: null,
        failureReason: "NO_MATCH",
      };
    }

    const cacheKey = this.buildValidationCacheKey(query, options?.sessionToken);
    const cachedResult = this.getCachedValidationResult(cacheKey);
    if (cachedResult) {
      this.logger.debug(
        {
          operation: "validate",
          queryLength: query.length,
          cacheHit: true,
        },
        "Address validation served from cache",
      );
      return cachedResult;
    }

    const { suggestions } = await this.fetchAutocompleteSuggestions(query, {
      limit: this.maxSuggestions,
      sessionToken: options?.sessionToken,
    });
    if (suggestions.length === 0) {
      this.logger.debug({ failureReason: "NO_MATCH" }, "Address validation failed");
      const result: AddressLookupResult = {
        isValid: false,
        normalizedAddress: null,
        placeId: null,
        failureReason: "NO_MATCH",
      };
      this.cacheValidationResult(cacheKey, result);
      return result;
    }

    const topMatch = suggestions[0];
    const { details } = topMatch?.placeId
      ? await this.fetchPlaceDetails(topMatch.placeId, {
          sessionToken: options?.sessionToken,
        })
      : { details: null };

    if (details && this.isAreaOnlyFromPlaceDetails(details)) {
      this.logger.debug({ failureReason: "AREA_ONLY" }, "Address validation failed");
      const result: AddressLookupResult = {
        isValid: false,
        normalizedAddress: null,
        placeId: null,
        failureReason: "AREA_ONLY",
      };
      this.cacheValidationResult(cacheKey, result);
      return result;
    }

    if (details && this.isSpecificAddressFromPlaceDetails(details)) {
      const result: AddressLookupResult = {
        isValid: true,
        normalizedAddress: details.formattedAddress ?? topMatch?.description ?? null,
        placeId: topMatch?.placeId ?? null,
        failureReason: null,
      };
      this.cacheValidationResult(cacheKey, result);
      return result;
    }

    if (!details && this.isAreaOnlyInput(query, suggestions)) {
      this.logger.debug({ failureReason: "AREA_ONLY" }, "Address validation failed");
      const result: AddressLookupResult = {
        isValid: false,
        normalizedAddress: null,
        placeId: null,
        failureReason: "AREA_ONLY",
      };
      this.cacheValidationResult(cacheKey, result);
      return result;
    }

    const isValid =
      this.isSpecificAddressQuery(query) &&
      this.isLikelyExactAddressMatch(query, topMatch?.description ?? "");

    const result: AddressLookupResult = {
      isValid,
      normalizedAddress: isValid ? (topMatch?.description ?? null) : null,
      placeId: isValid ? (topMatch?.placeId ?? null) : null,
      failureReason: isValid ? null : "AMBIGUOUS",
    };
    if (!result.isValid) {
      this.logger.debug({ failureReason: result.failureReason }, "Address validation failed");
    }

    this.cacheValidationResult(cacheKey, result);
    return result;
  }

  private async fetchAutocompleteSuggestions(
    query: string,
    options: { limit?: number; sessionToken?: string },
  ): Promise<{ suggestions: PlaceSuggestion[]; degraded: boolean }> {
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
          ...(options.sessionToken && { sessionToken: options.sessionToken }),
        },
      );

      const suggestions = (data.suggestions ?? [])
        .map((suggestion) => suggestion.placePrediction)
        .filter((prediction): prediction is NonNullable<typeof prediction> => !!prediction)
        .filter((prediction) => prediction.text?.text && prediction.placeId)
        .slice(0, this.resolveSuggestionLimit(options.limit))
        .map((prediction) => ({
          placeId: prediction.placeId,
          description: prediction.text?.text ?? "",
          types: prediction.types ?? [],
        }));
      return { suggestions, degraded: false };
    } catch (error) {
      const info = this.httpClientService.handleError(
        error,
        "fetchAutocompleteSuggestions",
        "GooglePlaces",
      );
      this.logger.warn(
        {
          queryLength: query.length,
          status: info.status,
          error: info.message,
        },
        "Autocomplete suggestions failed",
      );
      return { suggestions: [], degraded: true };
    }
  }

  private async fetchPlaceDetails(
    placeId: string,
    options?: { sessionToken?: string },
  ): Promise<{ details: PlaceDetailsResponse | null; degraded: boolean }> {
    try {
      const { data } = await this.httpClient.get<PlaceDetailsResponse>(
        `${this.placeDetailsBaseUrl}/${encodeURIComponent(placeId)}`,
        {
          headers: {
            "X-Goog-FieldMask":
              "id,types,displayName,formattedAddress,businessStatus,addressComponents",
          },
          params: {
            ...(options?.sessionToken && { sessionToken: options.sessionToken }),
          },
        },
      );
      return { details: data ?? null, degraded: false };
    } catch (error) {
      const info = this.httpClientService.handleError(error, "fetchPlaceDetails", "GooglePlaces");
      this.logger.warn(
        {
          placeIdSuffix: placeId.slice(-6),
          status: info.status,
          error: info.message,
        },
        "Place details fetch failed",
      );
      return { details: null, degraded: true };
    }
  }

  private resolveSuggestionLimit(inputLimit?: number): number {
    const resolvedLimit = inputLimit ?? this.maxSuggestions;
    return Math.min(this.maxAllowedSuggestions, Math.max(1, resolvedLimit));
  }

  private formatResolvedAddress(details: PlaceDetailsResponse): string | null {
    const displayName = details.displayName?.text?.trim() ?? "";
    const displayNamePrefix = details.businessStatus && displayName ? `${displayName}, ` : "";
    const cleanedAddress = details.formattedAddress
      ?.replace(/(?:,?\s*\d{5,6})?,\s*Lagos,\s*Nigeria\.?$/i, "")
      .trim();
    const reconstructedAddress = this.buildAddressFromComponents(details);
    const displayNameAddress = this.buildAddressFromDisplayName(details, cleanedAddress ?? null);
    const resolvedAddress = reconstructedAddress ?? displayNameAddress ?? cleanedAddress ?? "";
    const addressWithoutDuplicatedName =
      details.businessStatus && displayName
        ? this.removeLeadingDisplayName(resolvedAddress, displayName)
        : resolvedAddress;
    const formattedAddress = `${displayNamePrefix}${addressWithoutDuplicatedName}`.trim();
    if (!formattedAddress) {
      return null;
    }

    return formattedAddress;
  }

  private buildAddressFromDisplayName(
    details: PlaceDetailsResponse,
    cleanedAddress: string | null,
  ): string | null {
    if (details.businessStatus) {
      return null;
    }

    const displayName = details.displayName?.text?.trim();
    if (!displayName) {
      return null;
    }

    if (cleanedAddress && this.isSpecificAddressQuery(cleanedAddress)) {
      return null;
    }

    const hasSpecificSignal =
      /\b\d+[a-z]?\b/i.test(displayName) ||
      /\b(street|st|road|rd|avenue|ave|close|crescent|lane|drive|boulevard|way|expressway)\b/i.test(
        displayName,
      );
    if (!hasSpecificSignal) {
      return null;
    }

    const areaTail = this.buildAreaTailFromComponents(details) ?? cleanedAddress;
    if (!areaTail) {
      return displayName;
    }

    return `${displayName}, ${areaTail}`.trim();
  }

  private buildAreaTailFromComponents(details: PlaceDetailsResponse): string | null {
    const addressComponents = details.addressComponents ?? [];
    if (addressComponents.length === 0) {
      return null;
    }

    const district =
      this.getAddressComponentText(addressComponents, "neighborhood") ??
      this.getAddressComponentText(addressComponents, "sublocality") ??
      this.getAddressComponentText(addressComponents, "sublocality_level_1");
    const locality =
      this.getAddressComponentText(addressComponents, "locality") ??
      this.getAddressComponentText(addressComponents, "administrative_area_level_2") ??
      this.getAddressComponentText(addressComponents, "administrative_area_level_1");

    const segments = [district, locality]
      .map((segment) => segment?.trim())
      .filter((segment): segment is string => !!segment);
    const dedupedSegments = segments.filter(
      (segment, index, list) =>
        list.findIndex((candidate) => candidate.toLowerCase() === segment.toLowerCase()) === index,
    );
    return dedupedSegments.length > 0 ? dedupedSegments.join(", ") : null;
  }

  private buildAddressFromComponents(details: PlaceDetailsResponse): string | null {
    const addressComponents = details.addressComponents ?? [];
    if (addressComponents.length === 0) {
      return null;
    }

    const streetNumber = this.getAddressComponentText(addressComponents, "street_number");
    const route =
      this.getAddressComponentText(addressComponents, "route", { preferShortText: true }) ??
      this.getAddressComponentText(addressComponents, "route");
    if (!streetNumber || !route) {
      return null;
    }

    const district =
      this.getAddressComponentText(addressComponents, "neighborhood") ??
      this.getAddressComponentText(addressComponents, "sublocality") ??
      this.getAddressComponentText(addressComponents, "sublocality_level_1");
    const locality =
      this.getAddressComponentText(addressComponents, "locality") ??
      this.getAddressComponentText(addressComponents, "administrative_area_level_2") ??
      this.getAddressComponentText(addressComponents, "administrative_area_level_1");

    const segments = [`${streetNumber} ${route}`.trim(), district, locality]
      .map((segment) => segment?.trim())
      .filter((segment): segment is string => !!segment);

    const dedupedSegments = segments.filter(
      (segment, index, list) =>
        list.findIndex((candidate) => candidate.toLowerCase() === segment.toLowerCase()) === index,
    );
    return dedupedSegments.length > 0 ? dedupedSegments.join(", ") : null;
  }

  private getAddressComponentText(
    components: NonNullable<PlaceDetailsResponse["addressComponents"]>,
    type: string,
    options?: { preferShortText?: boolean },
  ): string | null {
    const component = components.find((entry) => (entry.types ?? []).includes(type));
    if (!component) {
      return null;
    }

    if (options?.preferShortText && component.shortText?.trim()) {
      return component.shortText.trim();
    }

    if (component.longText?.trim()) {
      return component.longText.trim();
    }

    if (component.shortText?.trim()) {
      return component.shortText.trim();
    }

    return null;
  }

  private removeLeadingDisplayName(address: string, displayName: string): string {
    if (!address || !displayName) {
      return address;
    }

    const escapedDisplayName = displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return address.replace(new RegExp(`^${escapedDisplayName},?\\s*`, "i"), "").trim();
  }

  private buildValidationCacheKey(input: string, sessionToken?: string): string {
    const normalizedInput = input.trim().toLowerCase();
    const normalizedToken = sessionToken?.trim() || "anonymous";
    return `${normalizedInput}::${normalizedToken}`;
  }

  private getCachedValidationResult(cacheKey: string): AddressLookupResult | null {
    const entry = this.validationResultCache.get(cacheKey);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.validationResultCache.delete(cacheKey);
      return null;
    }

    return { ...entry.result };
  }

  private cacheValidationResult(cacheKey: string, result: AddressLookupResult): void {
    this.cleanupExpiredValidationCache();
    this.validationResultCache.set(cacheKey, {
      expiresAt: Date.now() + this.validationCacheTtlMs,
      result,
    });
  }

  private cleanupExpiredValidationCache(): void {
    if (this.validationResultCache.size === 0) {
      return;
    }

    const now = Date.now();
    for (const [cacheKey, entry] of this.validationResultCache.entries()) {
      if (entry.expiresAt <= now) {
        this.validationResultCache.delete(cacheKey);
      }
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
    if (hasStreetNumber && hasRoute) {
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
