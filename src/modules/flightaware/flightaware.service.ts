import { HttpStatus, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AxiosInstance } from "axios";
import { differenceInDays, formatDistanceToNow } from "date-fns";
import { EnvConfig } from "src/config/env.config";
import { HttpClientService } from "../http-client/http-client.service";
import { FLIGHT_NUMBER_REGEX, IATA_TO_ICAO_MAP } from "./flightaware.const";
import {
  FlightAlreadyLandedException,
  FlightAwareApiException,
  FlightNotFoundException,
  InvalidFlightNumberException,
} from "./flightaware.error";
import type {
  FlightAwareFlightLeg,
  FlightAwareResponse,
  FlightAwareScheduledFlight,
  FlightAwareSchedulesResponse,
  SearchFlightResult,
  ValidatedFlight,
} from "./flightaware.interface";

/**
 * Internal result type for flight validation (used for caching and internal processing).
 * The public API throws exceptions instead of returning this type.
 */
type InternalFlightResult =
  | { type: "success"; flight: ValidatedFlight }
  | { type: "alreadyLanded"; flightNumber: string; landedTime: string; nextFlightDate?: string }
  | { type: "notFound" }
  | { type: "error"; message: string };

const ISO_DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const SUPPORTED_PICKUP_DESTINATIONS = new Set(["LOS"]);
const SUPPORTED_ALREADY_LANDED_DESTINATIONS = new Set(["LOS"]);

/**
 * Service for interacting with FlightAware AeroAPI
 * Handles flight validation and alert management
 */
@Injectable()
export class FlightAwareService implements OnModuleDestroy {
  private readonly logger = new Logger(FlightAwareService.name);
  private readonly apiKey: string;
  private readonly timezone: string;
  private readonly baseUrl = "https://aeroapi.flightaware.com/aeroapi";
  private readonly httpClient: AxiosInstance;
  private readonly cleanupIntervalId: NodeJS.Timeout;

  /** In-memory cache for flight validation results (null = not found) */
  private readonly flightCache = new Map<
    string,
    { data: ValidatedFlight | null; expiresAt: number }
  >();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly NOT_FOUND_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly configService: ConfigService<EnvConfig>,
    private readonly httpClientService: HttpClientService,
  ) {
    this.apiKey = this.configService.get("FLIGHTAWARE_API_KEY", { infer: true });
    this.timezone = this.configService.get("TZ", { infer: true });

    this.httpClient = this.httpClientService.createClient({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        "x-apikey": this.apiKey,
        Accept: "application/json",
      },
      serviceName: "FlightAware",
    });

    // Start periodic cache cleanup
    this.cleanupIntervalId = setInterval(() => this.cleanupExpiredCacheEntries(), 60 * 60 * 1000);
  }

  /**
   * Validate and search for a flight using FlightAware AeroAPI.
   *
   * @param flightNumber - IATA flight number (e.g., "BA74", "AA123")
   * @param pickupDate - ISO date string (e.g., "2025-12-25")
   * @returns The validated flight data
   * @throws FlightNotFoundException if the flight is not found
   * @throws FlightAlreadyLandedException if the flight has already landed
   * @throws InvalidFlightNumberException if the flight number format is invalid
   * @throws FlightAwareApiException if there's an API error
   */
  async validateFlight(flightNumber: string, pickupDate: string): Promise<ValidatedFlight> {
    // 1. Validate format
    if (!this.isValidFlightNumberFormat(flightNumber)) {
      throw new InvalidFlightNumberException(flightNumber);
    }

    const normalizedFlightNumber = flightNumber.toUpperCase();

    // 2. Check cache
    const cached = this.getCachedFlight(normalizedFlightNumber, pickupDate);
    if (cached !== undefined) {
      this.logger.debug("Flight cache HIT", { flightNumber: normalizedFlightNumber, pickupDate });
      if (cached === null) {
        throw new FlightNotFoundException(normalizedFlightNumber, pickupDate);
      }
      return cached;
    }

    this.logger.debug("Flight cache MISS - calling API", {
      flightNumber: normalizedFlightNumber,
      pickupDate,
    });

    // 3. Calculate search window
    const { startDate, endDate } = this.getPickupSearchWindow(pickupDate);

    // Determine which API to use based on how far in the future
    const now = new Date();
    const diffDays = differenceInDays(startDate, now);
    const useLiveAPI = diffDays < 2;

    let result: InternalFlightResult;

    if (useLiveAPI) {
      const maxEndDate = new Date(now);
      maxEndDate.setUTCDate(maxEndDate.getUTCDate() + 2);
      const cappedEndDate = new Date(Math.min(endDate.getTime(), maxEndDate.getTime()));

      result = await this.fetchLiveFlight(
        normalizedFlightNumber,
        startDate,
        cappedEndDate,
        pickupDate,
      );
    } else {
      result = await this.fetchScheduledFlight(normalizedFlightNumber, startDate, endDate);
    }

    // Convert result to exception or return flight
    return this.handleFlightResult(result, normalizedFlightNumber, pickupDate);
  }

  async searchAirportPickupFlight(
    flightNumber: string,
    pickupDate: string,
  ): Promise<SearchFlightResult> {
    const flight = await this.validateFlight(flightNumber, pickupDate);
    const destinationCode = this.normalizeDestinationCode(
      flight.destinationIATA,
      flight.destination,
    );

    if (!destinationCode || !SUPPORTED_PICKUP_DESTINATIONS.has(destinationCode)) {
      const destinationName = flight.destinationIATA || flight.destination;
      const originName = flight.originIATA || flight.origin;

      return {
        message: `Flight ${flightNumber.toUpperCase()} flies from ${originName} to ${destinationName}. We only provide airport pickup for flights arriving in Lagos (LOS).`,
        flight: null,
      };
    }

    return {
      flight,
      warning: this.getArrivalWarning(flight),
    };
  }

  /**
   * Convert internal flight result to either a ValidatedFlight or throw an exception.
   */
  private handleFlightResult(
    result: InternalFlightResult,
    flightNumber: string,
    pickupDate: string,
  ): ValidatedFlight {
    switch (result.type) {
      case "success":
        // Cache successful result
        this.setCachedFlight(flightNumber, pickupDate, result.flight);
        return result.flight;

      case "notFound":
        // Cache not found result
        this.setCachedFlight(flightNumber, pickupDate, null);
        throw new FlightNotFoundException(flightNumber, pickupDate);

      case "alreadyLanded":
        // Don't cache - time sensitive
        throw new FlightAlreadyLandedException(
          result.flightNumber,
          result.landedTime,
          result.nextFlightDate,
        );

      case "error":
        // Don't cache errors
        throw new FlightAwareApiException(result.message);
    }
  }

  private getArrivalWarning(flight: {
    actualArrival?: string;
    estimatedArrival?: string;
    scheduledArrival: string;
  }): string | undefined {
    const arrivalTime = new Date(
      flight.actualArrival ?? flight.estimatedArrival ?? flight.scheduledArrival,
    );
    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

    if (arrivalTime < now) {
      return "This flight has already landed.";
    }

    if (arrivalTime < oneHourFromNow) {
      const timeUntilArrival = formatDistanceToNow(arrivalTime, { addSuffix: false });
      return `This flight arrives in ${timeUntilArrival}. We require at least 1 hour advance notice to arrange an airport pickup. For immediate pickup needs, please contact us directly.`;
    }

    return undefined;
  }

  /**
   * Validate flight number format
   */
  isValidFlightNumberFormat(flightNumber: string): boolean {
    return FLIGHT_NUMBER_REGEX.test(flightNumber);
  }

  // Private methods

  private getPickupSearchWindow(pickupDate: string): { startDate: Date; endDate: Date } {
    const dateOnlyMatch = ISO_DATE_ONLY_REGEX.exec(pickupDate);
    const baseUtcDate = dateOnlyMatch
      ? this.buildUtcDateFromDateOnly(dateOnlyMatch)
      : this.buildUtcDateFromIsoString(pickupDate);

    const startDate = new Date(baseUtcDate);
    startDate.setUTCHours(startDate.getUTCHours() - 12, 0, 0, 0);

    const endDate = new Date(baseUtcDate);
    endDate.setUTCDate(endDate.getUTCDate() + 1);
    endDate.setUTCHours(endDate.getUTCHours() + 12, 0, 0, 0);

    return { startDate, endDate };
  }

  private buildUtcDateFromDateOnly(dateMatch: RegExpExecArray): Date {
    const year = Number.parseInt(dateMatch[1], 10);
    const month = Number.parseInt(dateMatch[2], 10);
    const day = Number.parseInt(dateMatch[3], 10);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new FlightAwareApiException(`Invalid pickup date: ${dateMatch[0]}`);
    }

    return date;
  }

  private buildUtcDateFromIsoString(value: string): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new FlightAwareApiException(`Invalid pickup date: ${value}`);
    }
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  }

  private async fetchLiveFlight(
    flightNumber: string,
    startDate: Date,
    endDate: Date,
    pickupDate: string,
  ): Promise<InternalFlightResult> {
    const start = startDate.toISOString();
    const end = endDate.toISOString();

    const tryFlightNumber = async (flightNum: string): Promise<InternalFlightResult | null> => {
      const apiUrl = `/flights/${flightNum}?start=${start}&end=${end}`;
      this.logger.debug("FlightAware LIVE API request", { apiUrl });

      try {
        const response = await this.httpClient.get<FlightAwareResponse>(apiUrl);
        const data = response.data;

        const { matchingFlight, landedFlight, nextFlightDate } = this.findMatchingFlight(
          data.flights,
          pickupDate,
        );

        if (matchingFlight) {
          return this.buildSuccessResult(matchingFlight, flightNumber);
        }

        if (landedFlight) {
          const landedResult = this.buildAlreadyLandedResult(
            landedFlight,
            flightNumber,
            nextFlightDate,
          );
          if (landedResult) return landedResult;
        }

        return { type: "notFound" };
      } catch (error) {
        return this.handleApiError(error, flightNum, "fetchLiveFlight");
      }
    };

    let result = await tryFlightNumber(flightNumber);
    if (result && result.type !== "notFound") return result;

    // Try converting IATA to ICAO
    const icaoFlightNumber = this.convertIATAToICAO(flightNumber);
    if (icaoFlightNumber) {
      result = await tryFlightNumber(icaoFlightNumber);
      if (result && result.type !== "notFound") return result;
    }

    return { type: "notFound" };
  }

  private async fetchScheduledFlight(
    flightNumber: string,
    startDate: Date,
    endDate: Date,
  ): Promise<InternalFlightResult> {
    const startDateStr = startDate.toISOString().split("T")[0];
    const endDateStr = endDate.toISOString().split("T")[0];

    const tryScheduledFlight = async (flightNum: string): Promise<InternalFlightResult | null> => {
      const match2 = /^([A-Z0-9]{2})(\d{1,5})$/i.exec(flightNum);
      const match3 = /^([A-Z0-9]{3})(\d{1,5})$/i.exec(flightNum);
      const match = match2 || match3;

      if (!match) {
        return { type: "notFound" };
      }

      const airlineCode = match[1].toUpperCase();
      const flightNumDigits = match[2];

      const apiUrl = `/schedules/${startDateStr}/${endDateStr}?airline=${airlineCode}&flight_number=${flightNumDigits}`;
      this.logger.debug("FlightAware SCHEDULES API request", { apiUrl });

      try {
        const response = await this.httpClient.get<FlightAwareSchedulesResponse>(apiUrl);
        const data = response.data;

        if (!data.scheduled || data.scheduled.length === 0) {
          return { type: "notFound" };
        }

        const scheduledFlight = this.findScheduledFlight(data.scheduled, flightNum);
        return this.buildScheduledSuccessResult(scheduledFlight, flightNumber);
      } catch (error) {
        return this.handleApiError(error, flightNum, "fetchScheduledFlight");
      }
    };

    let result = await tryScheduledFlight(flightNumber);
    if (result && result.type !== "notFound") return result;

    const icaoFlightNumber = this.convertIATAToICAO(flightNumber);
    if (icaoFlightNumber) {
      result = await tryScheduledFlight(icaoFlightNumber);
      if (result && result.type !== "notFound") return result;
    }

    return { type: "notFound" };
  }

  private convertIATAToICAO(flightNumber: string): string | null {
    const match2 = /^([A-Z0-9]{2})(\d{1,5})$/i.exec(flightNumber);
    const match3 = /^([A-Z0-9]{3})(\d{1,5})$/i.exec(flightNumber);

    let airlineCode: string | null = null;
    let flightNum: string | null = null;

    if (match2?.[1]) {
      airlineCode = match2[1].toUpperCase();
      flightNum = match2[2];
    } else if (match3?.[1]) {
      airlineCode = match3[1].toUpperCase();
      flightNum = match3[2];
    }

    if (!airlineCode || !flightNum) return null;

    const icaoCode = IATA_TO_ICAO_MAP[airlineCode];
    return icaoCode ? `${icaoCode}${flightNum}` : null;
  }

  private handleApiError(
    error: unknown,
    flightNum: string,
    operation = "fetchFlight",
  ): InternalFlightResult {
    const errorInfo = this.httpClientService.handleError(error, operation, "FlightAware");
    this.logger.warn("FlightAware API error", { operation, status: errorInfo.status, flightNum });

    if (errorInfo.status === HttpStatus.NOT_FOUND) {
      return { type: "notFound" };
    }
    if (errorInfo.status === HttpStatus.UNAUTHORIZED) {
      return { type: "error", message: "FlightAware API authentication failed" };
    }
    if (errorInfo.status === HttpStatus.TOO_MANY_REQUESTS) {
      return { type: "error", message: "FlightAware API rate limit exceeded" };
    }

    return {
      type: "error",
      message: `FlightAware API error: ${errorInfo.status || errorInfo.message}`,
    };
  }

  private findMatchingFlight(
    flights: FlightAwareFlightLeg[],
    pickupDateStr: string,
  ): {
    matchingFlight: FlightAwareFlightLeg | null;
    landedFlight: FlightAwareFlightLeg | null;
    nextFlightDate: string | null;
  } {
    const now = new Date();
    let matchingFlight: FlightAwareFlightLeg | null = null;
    let landedFlight: FlightAwareFlightLeg | null = null;
    let nextFlightDate: string | null = null;

    for (const flight of flights) {
      const arrivalTimeUTC = flight.actual_on || flight.estimated_on || flight.scheduled_on;
      const arrivalDate = new Date(arrivalTimeUTC);
      const localeDateStr = this.toLocaleDateString(arrivalDate);

      if (localeDateStr === pickupDateStr) {
        if (arrivalDate < now) {
          landedFlight = flight;
        } else {
          matchingFlight = flight;
          break;
        }
      } else if (arrivalDate > now && !nextFlightDate) {
        nextFlightDate = localeDateStr;
      }
    }

    return { matchingFlight, landedFlight, nextFlightDate };
  }

  private findScheduledFlight(
    scheduled: FlightAwareScheduledFlight[],
    flightNum: string,
  ): FlightAwareScheduledFlight {
    const normalizedFlight = flightNum.toUpperCase();
    return (
      scheduled.find(
        (flight) =>
          flight.ident_iata?.toUpperCase() === normalizedFlight ||
          flight.actual_ident_iata?.toUpperCase() === normalizedFlight ||
          flight.ident?.toUpperCase() === normalizedFlight,
      ) ?? scheduled[0]
    );
  }

  private buildSuccessResult(
    flight: FlightAwareFlightLeg,
    flightNumber: string,
  ): InternalFlightResult {
    return {
      type: "success",
      flight: {
        flightNumber,
        flightId: flight.fa_flight_id,
        origin: flight.origin.code,
        originIATA: flight.origin.code_iata,
        originName: flight.origin.name,
        destination: flight.destination.code,
        destinationIATA: flight.destination.code_iata,
        destinationName: flight.destination.name,
        destinationCity: flight.destination.city,
        scheduledArrival: flight.scheduled_on,
        estimatedArrival: flight.estimated_in,
        actualArrival: flight.actual_on,
        status: flight.status,
        aircraftType: flight.aircraft_type,
        delay: flight.delay,
        isLive: true,
      },
    };
  }

  private async buildScheduledSuccessResult(
    scheduledFlight: FlightAwareScheduledFlight,
    flightNumber: string,
  ): Promise<InternalFlightResult> {
    const scheduledArrival =
      scheduledFlight.estimated_in ??
      scheduledFlight.scheduled_in ??
      scheduledFlight.actual_in ??
      scheduledFlight.scheduled_on;

    if (!scheduledArrival) {
      return { type: "notFound" };
    }

    // Fetch airport info for destination details
    let destinationName: string | undefined;
    let destinationCity: string | undefined;
    let originName: string | undefined;

    const [destinationResult, originResult] = await Promise.allSettled([
      this.httpClient.get<{ name?: string; city?: string }>(
        `/airports/${scheduledFlight.destination}`,
      ),
      this.httpClient.get<{ name?: string }>(`/airports/${scheduledFlight.origin}`),
    ]);

    if (destinationResult.status === "fulfilled") {
      destinationName = destinationResult.value?.data?.name;
      destinationCity = destinationResult.value?.data?.city;
    }
    if (originResult.status === "fulfilled") {
      originName = originResult.value?.data?.name;
    }

    return {
      type: "success",
      flight: {
        flightNumber,
        flightId: scheduledFlight.fa_flight_id || `${flightNumber}-scheduled`,
        origin: scheduledFlight.origin,
        originIATA: scheduledFlight.origin_iata ?? undefined,
        originName,
        destination: scheduledFlight.destination,
        destinationIATA: scheduledFlight.destination_iata ?? undefined,
        destinationName,
        destinationCity,
        scheduledArrival,
        status: "Scheduled",
        aircraftType: scheduledFlight.aircraft_type ?? undefined,
        isLive: false,
      },
    };
  }

  private buildAlreadyLandedResult(
    landedFlight: FlightAwareFlightLeg,
    flightNumber: string,
    nextFlightDate: string | null,
  ): InternalFlightResult | null {
    const destinationCode = this.normalizeDestinationCode(
      landedFlight.destination.code_iata,
      landedFlight.destination.code,
    );

    if (!destinationCode || !SUPPORTED_ALREADY_LANDED_DESTINATIONS.has(destinationCode)) {
      return null;
    }

    const landedTime = this.formatLocaleTime(
      landedFlight.actual_on || landedFlight.estimated_on || landedFlight.scheduled_on,
    );

    return {
      type: "alreadyLanded",
      flightNumber,
      landedTime,
      nextFlightDate: nextFlightDate ?? undefined,
    };
  }

  private normalizeDestinationCode(
    destinationIATA: string | undefined,
    destinationICAO: string | undefined,
  ): string | undefined {
    return destinationIATA ?? (destinationICAO === "DNMM" ? "LOS" : undefined);
  }

  private toLocaleDateString(date: Date): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date); // Returns "YYYY-MM-DD"
  }

  private formatLocaleTime(timeUTC: string): string {
    return new Date(timeUTC).toLocaleTimeString("en-US", {
      timeZone: this.timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  // Cache methods

  private getCacheKey(flightNumber: string, date: string): string {
    return `flight:${flightNumber.toUpperCase()}:${date}`;
  }

  /**
   * Get cached flight result.
   * @returns ValidatedFlight if found and valid, null if flight was cached as not found,
   *          undefined if not in cache or expired
   */
  private getCachedFlight(flightNumber: string, date: string): ValidatedFlight | null | undefined {
    const key = this.getCacheKey(flightNumber, date);
    const cached = this.flightCache.get(key);

    if (!cached) return undefined;

    if (Date.now() > cached.expiresAt) {
      this.flightCache.delete(key);
      return undefined;
    }

    return cached.data;
  }

  /**
   * Cache a flight result.
   * @param data - ValidatedFlight for successful lookup, null for not found
   */
  private setCachedFlight(flightNumber: string, date: string, data: ValidatedFlight | null): void {
    const key = this.getCacheKey(flightNumber, date);
    const ttl = data === null ? this.NOT_FOUND_CACHE_TTL_MS : this.CACHE_TTL_MS;

    this.flightCache.set(key, {
      data,
      expiresAt: Date.now() + ttl,
    });
  }

  private cleanupExpiredCacheEntries(): void {
    const now = Date.now();
    let removedCount = 0;

    for (const [key, value] of this.flightCache.entries()) {
      if (now > value.expiresAt) {
        this.flightCache.delete(key);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      this.logger.debug("Cleaned up expired cache entries", {
        removedCount,
        remainingCount: this.flightCache.size,
      });
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupIntervalId);
  }
}
