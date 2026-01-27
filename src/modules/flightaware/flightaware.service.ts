import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { differenceInDays, format } from "date-fns";
import { AxiosInstance } from "axios";
import { DatabaseService } from "../database/database.service";
import { HttpClientService } from "../../shared/http-client.service";
import type {
  CreateAlertParams,
  FlightAwareAlertResponse,
  FlightAwareFlightLeg,
  FlightAwareResponse,
  FlightAwareScheduledFlight,
  FlightAwareSchedulesResponse,
  FlightValidationResult,
} from "./flightaware.interface";
import { EnvConfig } from "src/config/env.config";
import { IATA_TO_ICAO_MAP } from "./flightaware.const";

/**
 * Service for interacting with FlightAware AeroAPI
 * Handles flight validation and alert management
 */
@Injectable()
export class FlightAwareService {
  private readonly logger = new Logger(FlightAwareService.name);
  private readonly apiKey: string;
  private readonly baseUrl = "https://aeroapi.flightaware.com/aeroapi";
  private readonly httpClient: AxiosInstance;

  /** In-memory cache for flight validation results */
  private readonly flightCache = new Map<
    string,
    { data: FlightValidationResult; expiresAt: number }
  >();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private readonly configService: ConfigService<EnvConfig>,
    private readonly databaseService: DatabaseService,
    private readonly httpClientService: HttpClientService,
  ) {
    this.apiKey = this.configService.get("FLIGHTAWARE_API_KEY", { infer: true });

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
    setInterval(() => this.cleanupExpiredCacheEntries(), 60 * 60 * 1000); // Every hour
  }

  /**
   * Validate and search for a flight using FlightAware AeroAPI
   *
   * @param flightNumber - IATA flight number (e.g., "BA74", "AA123")
   * @param pickupDate - ISO date string (e.g., "2025-12-25")
   */
  async validateFlight(flightNumber: string, pickupDate: string): Promise<FlightValidationResult> {
    // 1. Validate format
    if (!this.isValidFlightNumberFormat(flightNumber)) {
      return {
        type: "error",
        message: `Invalid flight number format: ${flightNumber}. Expected format: 2-3 alphanumeric airline code + 1-5 digits (e.g., BA74, AA123, P47579)`,
      };
    }

    const normalizedFlightNumber = flightNumber.toUpperCase();

    // 2. Check cache
    const cached = this.getCachedFlight(normalizedFlightNumber, pickupDate);
    if (cached) {
      this.logger.debug("Flight cache HIT", { flightNumber: normalizedFlightNumber, pickupDate });
      return cached;
    }

    this.logger.debug("Flight cache MISS - calling API", {
      flightNumber: normalizedFlightNumber,
      pickupDate,
    });

    // 3. Calculate search window
    const startDate = new Date(pickupDate);
    startDate.setHours(0, 0, 0, 0);
    startDate.setHours(startDate.getHours() - 12);

    const endDate = new Date(pickupDate);
    endDate.setDate(endDate.getDate() + 1);
    endDate.setHours(0, 0, 0, 0);
    endDate.setHours(endDate.getHours() + 12);

    // Determine which API to use based on how far in the future
    const now = new Date();
    const diffDays = differenceInDays(startDate, now);
    const useLiveAPI = diffDays < 2;

    try {
      let result: FlightValidationResult;

      if (useLiveAPI) {
        const maxEndDate = new Date(now);
        maxEndDate.setDate(maxEndDate.getDate() + 2);
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

      // Cache the result (only caches "success" and "notFound")
      this.setCachedFlight(normalizedFlightNumber, pickupDate, result);

      return result;
    } catch (error) {
      this.logger.error(`Error validating flight ${normalizedFlightNumber}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        type: "error",
        message: error instanceof Error ? error.message : "An unexpected error occurred",
      };
    }
  }

  /**
   * Create a FlightAware alert for a flight
   */
  async createFlightAlert({
    flightNumber,
    flightDate,
    destinationIATA,
    events = ["arrival", "cancelled", "departure", "diverted"],
  }: CreateAlertParams): Promise<string> {
    const dateStr = format(flightDate, "yyyy-MM-dd");

    this.logger.log("Creating FlightAware alert", {
      flightNumber,
      flightDate: dateStr,
      events,
    });

    const requestBody: Record<string, unknown> = {
      ident: flightNumber.toUpperCase(),
      date_start: dateStr,
      date_end: dateStr,
      enabled: true,
      events,
    };

    if (destinationIATA) {
      requestBody.destination = destinationIATA;
    }

    try {
      const response = await this.httpClient.post<FlightAwareAlertResponse>("/alerts", requestBody);

      this.logger.log("FlightAware alert created", {
        alertId: response.data.alert_id,
        flightNumber: response.data.ident,
      });

      return response.data.alert_id;
    } catch (error) {
      const errorInfo = this.httpClientService.handleError(
        error,
        "createFlightAlert",
        "FlightAware",
      );

      if (errorInfo.status === 401) {
        throw new Error("FlightAware API authentication failed");
      }
      if (errorInfo.status === 429) {
        throw new Error("FlightAware API rate limit exceeded");
      }
      throw new Error(`FlightAware API error: ${errorInfo.status || errorInfo.message}`);
    }
  }

  /**
   * Get or create alert for a flight with deduplication
   */
  async getOrCreateFlightAlert(flightId: string, params: CreateAlertParams): Promise<string> {
    this.logger.log("Getting or creating flight alert", {
      flightId,
      flightNumber: params.flightNumber,
    });

    // Use advisory lock to prevent race conditions
    const lockId =
      Array.from(flightId).reduce((acc, char) => acc + (char.codePointAt(0) ?? 0), 0) % 2147483647;

    return this.databaseService.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_lock(${lockId})`;

      try {
        const flight = await tx.flight.findUnique({
          where: { id: flightId },
          select: { alertId: true, alertEnabled: true },
        });

        if (flight?.alertId && flight.alertEnabled) {
          this.logger.log("Flight already has active alert, reusing", {
            flightId,
            alertId: flight.alertId,
          });
          return flight.alertId;
        }
      } finally {
        await tx.$executeRaw`SELECT pg_advisory_unlock(${lockId})`;
      }

      const alertId = await this.createFlightAlert(params);

      await tx.flight.update({
        where: { id: flightId },
        data: { alertId, alertEnabled: true },
      });

      return alertId;
    });
  }

  /**
   * Disable/delete a FlightAware alert
   */
  async disableFlightAlert(alertId: string): Promise<void> {
    this.logger.log("Disabling FlightAware alert", { alertId });

    try {
      await this.httpClient.delete(`/alerts/${alertId}`);
      this.logger.log("FlightAware alert deleted", { alertId });
    } catch (error) {
      const errorInfo = this.httpClientService.handleError(
        error,
        "disableFlightAlert",
        "FlightAware",
      );

      // 404 is acceptable (alert already deleted)
      if (errorInfo.status === 404) {
        this.logger.log("FlightAware alert already deleted", { alertId });
        return;
      }

      if (errorInfo.status === 401) {
        throw new Error("FlightAware API authentication failed");
      }
      throw new Error(`FlightAware API error: ${errorInfo.status || errorInfo.message}`);
    }
  }

  /**
   * Cleanup alert when flight is completed or all bookings cancelled
   */
  async cleanupFlightAlert(flightId: string): Promise<void> {
    this.logger.log("Cleaning up flight alert", { flightId });

    const flight = await this.databaseService.flight.findUnique({
      where: { id: flightId },
      select: { alertId: true, alertEnabled: true },
    });

    if (!flight?.alertId || !flight.alertEnabled) {
      this.logger.log("Flight has no active alert to cleanup", { flightId });
      return;
    }

    await this.disableFlightAlert(flight.alertId);

    await this.databaseService.flight.update({
      where: { id: flightId },
      data: { alertEnabled: false },
    });

    this.logger.log("Flight alert cleaned up", { flightId, alertId: flight.alertId });
  }

  /**
   * Validate flight number format
   */
  isValidFlightNumberFormat(flightNumber: string): boolean {
    const pattern = /^[a-zA-Z0-9]{2,3}\d{1,5}$/;
    return pattern.test(flightNumber);
  }

  // Private methods

  private async fetchLiveFlight(
    flightNumber: string,
    startDate: Date,
    endDate: Date,
    pickupDate: string,
  ): Promise<FlightValidationResult> {
    const start = startDate.toISOString();
    const end = endDate.toISOString();

    const tryFlightNumber = async (flightNum: string): Promise<FlightValidationResult | null> => {
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
            pickupDate,
            nextFlightDate,
          );
          if (landedResult) return landedResult;
        }

        return { type: "notFound" };
      } catch (error) {
        return this.handleApiError(error, flightNum);
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
  ): Promise<FlightValidationResult> {
    const startDateStr = startDate.toISOString().split("T")[0];
    const endDateStr = endDate.toISOString().split("T")[0];

    const tryScheduledFlight = async (
      flightNum: string,
    ): Promise<FlightValidationResult | null> => {
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
        const errorInfo = this.httpClientService.handleError(
          error,
          "fetchScheduledFlight",
          "FlightAware",
        );

        if (errorInfo.status === 404) return { type: "notFound" };
        if (errorInfo.status === 401) {
          throw new Error("FlightAware API authentication failed");
        }
        if (errorInfo.status === 429) {
          throw new Error("FlightAware API rate limit exceeded");
        }
        throw new Error(`FlightAware API error: ${errorInfo.status || errorInfo.message}`);
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

  private handleApiError(error: unknown, flightNum: string): FlightValidationResult {
    const errorInfo = this.httpClientService.handleError(error, "fetchLiveFlight", "FlightAware");
    this.logger.warn("FlightAware API error", { status: errorInfo.status, flightNum });

    if (errorInfo.status === 404) return { type: "notFound" };
    if (errorInfo.status === 401) throw new Error("FlightAware API authentication failed");
    if (errorInfo.status === 429) throw new Error("FlightAware API rate limit exceeded");

    throw new Error(`FlightAware API error: ${errorInfo.status || errorInfo.message}`);
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
      const lagosDateStr = this.toLagosDateString(arrivalDate);

      if (lagosDateStr === pickupDateStr) {
        if (arrivalDate < now) {
          landedFlight = flight;
        } else {
          matchingFlight = flight;
          break;
        }
      } else if (arrivalDate > now && !nextFlightDate) {
        nextFlightDate = lagosDateStr;
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
  ): FlightValidationResult {
    return {
      type: "success",
      flight: {
        flightNumber,
        flightId: flight.fa_flight_id,
        origin: flight.origin.code,
        originIATA: flight.origin.code_iata,
        destination: flight.destination.code,
        destinationIATA: flight.destination.code_iata,
        scheduledArrival: flight.scheduled_on,
        estimatedArrival: flight.estimated_in,
        actualArrival: flight.actual_on,
        status: flight.status,
        aircraftType: flight.aircraft_type,
        delay: flight.delay,
        arrivalAddress: `${flight.destination.name}, ${flight.destination.city}`,
        isLive: true,
      },
    };
  }

  private async buildScheduledSuccessResult(
    scheduledFlight: FlightAwareScheduledFlight,
    flightNumber: string,
  ): Promise<FlightValidationResult> {
    const scheduledArrival =
      scheduledFlight.estimated_in ??
      scheduledFlight.scheduled_in ??
      scheduledFlight.actual_in ??
      scheduledFlight.scheduled_on;

    if (!scheduledArrival) {
      return { type: "notFound" };
    }

    // Fetch airport info for arrival address
    let arrivalAddress: string | undefined;
    try {
      const airportResponse = await this.httpClient.get<{ name: string; city: string }>(
        `/airports/${scheduledFlight.destination}`,
      );
      arrivalAddress = `${airportResponse.data.name}, ${airportResponse.data.city}`;
    } catch {
      // Ignore airport fetch errors
    }

    return {
      type: "success",
      flight: {
        flightNumber,
        flightId: scheduledFlight.fa_flight_id || `${flightNumber}-scheduled`,
        origin: scheduledFlight.origin,
        originIATA: scheduledFlight.origin_iata ?? undefined,
        destination: scheduledFlight.destination,
        destinationIATA: scheduledFlight.destination_iata ?? undefined,
        scheduledArrival,
        arrivalAddress,
        status: "Scheduled",
        aircraftType: scheduledFlight.aircraft_type ?? undefined,
        isLive: false,
      },
    };
  }

  private buildAlreadyLandedResult(
    landedFlight: FlightAwareFlightLeg,
    flightNumber: string,
    pickupDateStr: string,
    nextFlightDate: string | null,
  ): FlightValidationResult | null {
    const destinationIATA = landedFlight.destination.code_iata;

    if (destinationIATA !== "LOS") {
      return null;
    }

    const landedTime = this.formatLagosTime(
      landedFlight.actual_on || landedFlight.estimated_on || landedFlight.scheduled_on,
    );

    return {
      type: "alreadyLanded",
      flightNumber,
      requestedDate: pickupDateStr,
      landedTime,
      nextFlightDate: nextFlightDate ?? undefined,
    };
  }

  private toLagosDateString(date: Date): string {
    const lagosTime = new Date(date.toLocaleString("en-US", { timeZone: "Africa/Lagos" }));
    return `${lagosTime.getFullYear()}-${String(lagosTime.getMonth() + 1).padStart(2, "0")}-${String(lagosTime.getDate()).padStart(2, "0")}`;
  }

  private formatLagosTime(timeUTC: string): string {
    return new Date(timeUTC).toLocaleTimeString("en-US", {
      timeZone: "Africa/Lagos",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  // Cache methods

  private getCacheKey(flightNumber: string, date: string): string {
    return `flight:${flightNumber.toUpperCase()}:${date}`;
  }

  private getCachedFlight(flightNumber: string, date: string): FlightValidationResult | undefined {
    const key = this.getCacheKey(flightNumber, date);
    const cached = this.flightCache.get(key);

    if (!cached) return undefined;

    if (Date.now() > cached.expiresAt) {
      this.flightCache.delete(key);
      return undefined;
    }

    return cached.data;
  }

  private setCachedFlight(flightNumber: string, date: string, data: FlightValidationResult): void {
    // Don't cache time-sensitive results
    if (data.type === "alreadyLanded" || data.type === "error") {
      return;
    }

    const key = this.getCacheKey(flightNumber, date);
    this.flightCache.set(key, {
      data,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
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
}
