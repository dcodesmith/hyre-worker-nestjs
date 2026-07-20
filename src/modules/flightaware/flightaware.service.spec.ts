import { HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  createAxiosErrorWithResponse,
  createMockAxiosInstance,
  createMockHttpClientService,
} from "../http-client/http-client.fixtures";
import { HttpClientService } from "../http-client/http-client.service";
import {
  FlightAlreadyLandedException,
  FlightAwareApiException,
  FlightNonLagosDestinationException,
  FlightNotFoundException,
  InvalidFlightNumberException,
} from "./flightaware.error";
import type { ValidatedFlight } from "./flightaware.interface";
import { FlightAwareService } from "./flightaware.service";

describe("FlightAwareService", () => {
  let service: FlightAwareService;
  let mockHttpClient: ReturnType<typeof createMockAxiosInstance>;

  const mockConfigService = {
    get: vi.fn((key: string) => {
      if (key === "FLIGHTAWARE_API_KEY") return "test-api-key";
      if (key === "TZ") return "Africa/Lagos";
      return undefined;
    }),
  };

  let mockHttpClientService: ReturnType<typeof createMockHttpClientService>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockHttpClient = createMockAxiosInstance();
    mockHttpClientService = createMockHttpClientService(mockHttpClient);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightAwareService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: HttpClientService, useValue: mockHttpClientService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<FlightAwareService>(FlightAwareService);
  });

  afterEach(() => {
    // Clean up the interval before switching to real timers
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  describe("lifecycle hooks", () => {
    it("should clear the cache cleanup interval on module destroy", () => {
      // Verify onModuleDestroy can be called without errors
      // This ensures the interval ID is properly stored and can be cleared
      expect(() => service.onModuleDestroy()).not.toThrow();

      // Call it again to ensure it's idempotent (shouldn't throw even if already cleared)
      expect(() => service.onModuleDestroy()).not.toThrow();
    });
  });

  describe("isValidFlightNumberFormat", () => {
    it("should return true for valid 2-letter IATA codes", () => {
      expect(service.isValidFlightNumberFormat("BA74")).toBe(true);
      expect(service.isValidFlightNumberFormat("AA123")).toBe(true);
      expect(service.isValidFlightNumberFormat("EK501")).toBe(true);
    });

    it("should return true for valid 3-letter ICAO codes", () => {
      expect(service.isValidFlightNumberFormat("BAW74")).toBe(true);
      expect(service.isValidFlightNumberFormat("UAE501")).toBe(true);
    });

    it("should return true for alphanumeric airline codes", () => {
      expect(service.isValidFlightNumberFormat("P47579")).toBe(true);
      expect(service.isValidFlightNumberFormat("W31234")).toBe(true);
    });

    it("should return false for invalid formats", () => {
      expect(service.isValidFlightNumberFormat("B")).toBe(false);
      expect(service.isValidFlightNumberFormat("BA")).toBe(false);
      expect(service.isValidFlightNumberFormat("BAAW74")).toBe(false);
      expect(service.isValidFlightNumberFormat("BA-74")).toBe(false);
      expect(service.isValidFlightNumberFormat("")).toBe(false);
    });

    it("should accept numeric-prefix codes like 123456", () => {
      // The regex accepts 2-3 alphanumeric chars + 1-5 digits
      // "12" + "3456" matches the pattern
      expect(service.isValidFlightNumberFormat("123456")).toBe(true);
    });
  });

  describe("validateFlight", () => {
    it("should throw InvalidFlightNumberException for invalid flight number format", async () => {
      await expect(service.validateFlight("INVALID", "2025-12-25")).rejects.toThrow(
        InvalidFlightNumberException,
      );
    });

    it("should reject calendar-invalid ISO datetime inputs without calling FlightAware", async () => {
      await expect(service.validateFlight("BA74", "2026-02-30T00:00:00Z")).rejects.toThrow(
        FlightAwareApiException,
      );
      expect(mockHttpClient.get).not.toHaveBeenCalled();
    });

    it("should return cached result on cache hit", async () => {
      // First call - cache miss
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          flights: [
            {
              ident: "BA74",
              fa_flight_id: "BA74-123",
              origin: { code: "LHR", code_iata: "LHR" },
              destination: { code: "LOS", code_iata: "LOS", name: "Lagos", city: "Lagos" },
              scheduled_on: "2025-12-25T14:00:00Z",
              estimated_on: "2025-12-25T14:30:00Z",
              status: "En Route",
            },
          ],
        },
      });

      // Set time to a date before the flight
      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));

      const result1 = await service.validateFlight("BA74", "2025-12-25");
      expect(result1.flightId).toBe("BA74-123");
      expect(mockHttpClient.get).toHaveBeenCalledTimes(1);
      const liveUrl = mockHttpClient.get.mock.calls[0]?.[0] as string;
      expect(liveUrl).toContain("start=2025-12-24T12:00:00Z");
      expect(liveUrl).toContain("end=2025-12-26T12:00:00Z");

      // Second call - should use cache
      const result2 = await service.validateFlight("BA74", "2025-12-25");
      expect(result2.flightId).toBe("BA74-123");
      expect(mockHttpClient.get).toHaveBeenCalledTimes(1); // Still 1, cache hit
    });

    it("should remove expired live entries during minute-aligned cache cleanup", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          flights: [
            {
              ident: "BA74",
              fa_flight_id: "BA74-123",
              origin: { code: "LHR", code_iata: "LHR" },
              destination: { code: "LOS", code_iata: "LOS" },
              scheduled_on: "2025-12-25T14:00:00Z",
            },
          ],
        },
      });
      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));
      await service.validateFlight("BA74", "2025-12-25");
      const cache = (
        service as unknown as {
          flightCache: Map<string, { data: ValidatedFlight | null; expiresAt: number }>;
        }
      ).flightCache;

      expect(cache.size).toBe(1);
      vi.advanceTimersByTime(60_001);

      expect(cache.size).toBe(0);
    });

    it("should use the delayed gate estimate as the authoritative live arrival", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          flights: [
            {
              ident: "DAL54",
              fa_flight_id: "DAL54-20260720",
              origin: { code: "KATL", code_iata: "ATL" },
              destination: { code: "DNMM", code_iata: "LOS" },
              scheduled_on: "2026-07-20T08:12:00Z",
              scheduled_in: "2026-07-20T08:45:00Z",
              estimated_on: "2026-07-20T09:00:00Z",
              estimated_in: "2026-07-20T09:11:00Z",
              actual_on: null,
              actual_in: null,
              status: "On The Way! / Delayed",
            },
          ],
        },
      });

      vi.setSystemTime(new Date("2026-07-20T05:00:00Z"));

      const result = await service.validateFlight("DL54", "2026-07-20");

      expect(result).toMatchObject({
        scheduledArrival: "2026-07-20T08:45:00Z",
        estimatedArrival: "2026-07-20T09:11:00Z",
        arrivalTime: "2026-07-20T09:11:00Z",
        arrivalTimeSource: "estimated",
      });
      expect(result.actualArrival).toBeUndefined();
    });

    it("should prefer a runway actual over a stale gate estimate", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          flights: [
            {
              ident: "DAL54",
              fa_flight_id: "DAL54-20260720",
              origin: { code: "KATL", code_iata: "ATL" },
              destination: { code: "DNMM", code_iata: "LOS" },
              scheduled_on: "2026-07-20T08:12:00Z",
              scheduled_in: "2026-07-20T08:45:00Z",
              estimated_in: "2026-07-20T09:05:00Z",
              actual_on: "2026-07-20T09:10:00Z",
              actual_in: null,
              status: "Landed / Taxiing",
            },
          ],
        },
      });
      vi.setSystemTime(new Date("2026-07-20T09:00:00Z"));

      const result = await service.validateFlight("DL54", "2026-07-20");

      expect(result).toMatchObject({
        estimatedArrival: "2026-07-20T09:05:00Z",
        actualArrival: "2026-07-20T09:10:00Z",
        arrivalTime: "2026-07-20T09:10:00Z",
        arrivalTimeSource: "actual",
      });
    });

    it("should refresh a live flight after the one-minute cache TTL", async () => {
      const createLiveResponse = (estimatedIn: string) => ({
        data: {
          flights: [
            {
              ident: "DAL54",
              fa_flight_id: "DAL54-20260720",
              origin: { code: "KATL", code_iata: "ATL" },
              destination: { code: "DNMM", code_iata: "LOS" },
              scheduled_on: "2026-07-20T08:12:00Z",
              scheduled_in: "2026-07-20T08:45:00Z",
              estimated_in: estimatedIn,
              status: "On The Way! / Delayed",
            },
          ],
        },
      });
      mockHttpClient.get
        .mockResolvedValueOnce(createLiveResponse("2026-07-20T09:11:00Z"))
        .mockResolvedValueOnce(createLiveResponse("2026-07-20T09:30:00Z"));
      vi.setSystemTime(new Date("2026-07-20T05:00:00Z"));

      const initial = await service.validateFlight("DL54", "2026-07-20");
      const cached = await service.validateFlight("DL54", "2026-07-20");

      expect(initial.arrivalTime).toBe("2026-07-20T09:11:00Z");
      expect(cached.arrivalTime).toBe("2026-07-20T09:11:00Z");
      expect(mockHttpClient.get).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_001);
      const refreshed = await service.validateFlight("DL54", "2026-07-20");

      expect(refreshed.arrivalTime).toBe("2026-07-20T09:30:00Z");
      expect(mockHttpClient.get).toHaveBeenCalledTimes(2);
    });

    it("should throw FlightNotFoundException when no flights match", async () => {
      // Mock both IATA and ICAO attempts returning empty
      mockHttpClient.get.mockResolvedValueOnce({
        data: { flights: [] },
      });
      mockHttpClient.get.mockResolvedValueOnce({
        data: { flights: [] },
      });

      vi.setSystemTime(new Date("2025-12-24T10:00:00Z"));

      await expect(service.validateFlight("BA74", "2025-12-25")).rejects.toThrow(
        FlightNotFoundException,
      );
    });

    it("should throw FlightAwareApiException for API authentication errors", async () => {
      const axiosError = createAxiosErrorWithResponse(HttpStatus.UNAUTHORIZED, {
        message: "Invalid API key",
      });
      mockHttpClient.get.mockRejectedValueOnce(axiosError);

      vi.setSystemTime(new Date("2025-12-24T10:00:00Z"));

      await expect(service.validateFlight("BA74", "2025-12-25")).rejects.toThrow(
        FlightAwareApiException,
      );
    });

    it("should throw FlightAwareApiException for API rate limit errors", async () => {
      const axiosError = createAxiosErrorWithResponse(HttpStatus.TOO_MANY_REQUESTS, {
        message: "Rate limit exceeded",
      });
      mockHttpClient.get.mockRejectedValueOnce(axiosError);

      vi.setSystemTime(new Date("2025-12-24T10:00:00Z"));

      await expect(service.validateFlight("BA74", "2025-12-25")).rejects.toThrow(
        FlightAwareApiException,
      );
    });

    it("should use schedules API for flights more than 2 days in future", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          scheduled: [
            {
              ident: "BA74",
              ident_iata: "BA74",
              fa_flight_id: "BA74-scheduled",
              origin: "LHR",
              origin_iata: "LHR",
              destination: "LOS",
              destination_iata: "LOS",
              scheduled_on: "2025-12-30T13:30:00Z",
              scheduled_in: "2025-12-30T14:00:00Z",
              estimated_in: "2025-12-30T14:20:00Z",
            },
          ],
        },
      });

      // Mock airport info fetch
      mockHttpClient.get.mockResolvedValueOnce({
        data: { name: "Lagos Airport", city: "Lagos" },
      });

      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));

      const result = await service.validateFlight("BA74", "2025-12-30");
      expect(result.flightId).toBe("BA74-scheduled");
      expect(result.scheduledArrival).toBe("2025-12-30T14:00:00Z");
      expect(result.estimatedArrival).toBe("2025-12-30T14:20:00Z");
      expect(result.arrivalTime).toBe("2025-12-30T14:20:00Z");
      expect(result.arrivalTimeSource).toBe("estimated");

      // Verify schedules API was called
      expect(mockHttpClient.get).toHaveBeenCalledWith(expect.stringContaining("/schedules/"));
    });

    it("should use runway fallbacks from schedules when gate updates are unavailable", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          scheduled: [
            {
              ident: "BA74",
              ident_iata: "BA74",
              fa_flight_id: "BA74-scheduled",
              origin: "LHR",
              origin_iata: "LHR",
              destination: "LOS",
              destination_iata: "LOS",
              scheduled_in: "2025-12-30T14:00:00Z",
              estimated_on: "2025-12-30T14:10:00Z",
              actual_on: "2025-12-30T14:15:00Z",
            },
          ],
        },
      });
      mockHttpClient.get.mockResolvedValueOnce({
        data: { name: "Lagos Airport", city: "Lagos" },
      });
      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));

      const result = await service.validateFlight("BA74", "2025-12-30");

      expect(result).toMatchObject({
        scheduledArrival: "2025-12-30T14:00:00Z",
        estimatedArrival: "2025-12-30T14:10:00Z",
        actualArrival: "2025-12-30T14:15:00Z",
        arrivalTime: "2025-12-30T14:15:00Z",
        arrivalTimeSource: "actual",
      });
    });

    it("should handle undefined destination name and city", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          flights: [
            {
              ident: "BA74",
              fa_flight_id: "BA74-123",
              origin: { code: "LHR", code_iata: "LHR" },
              destination: { code: "LOS", code_iata: "LOS" }, // name and city are undefined
              scheduled_on: "2025-12-25T14:00:00Z",
              estimated_on: "2025-12-25T14:30:00Z",
              status: "En Route",
            },
          ],
        },
      });

      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));

      const result: ValidatedFlight = await service.validateFlight("BA74", "2025-12-25");
      // destinationName and destinationCity should be undefined when not provided
      expect(result.destinationName).toBeUndefined();
      expect(result.destinationCity).toBeUndefined();
      expect(result.destination).toBe("LOS");
    });

    it("should handle partial destination info (only city)", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          flights: [
            {
              ident: "BA74",
              fa_flight_id: "BA74-123",
              origin: { code: "LHR", code_iata: "LHR" },
              destination: { code: "LOS", code_iata: "LOS", city: "Lagos" }, // name is undefined
              scheduled_on: "2025-12-25T14:00:00Z",
              estimated_on: "2025-12-25T14:30:00Z",
              status: "En Route",
            },
          ],
        },
      });

      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));

      const result: ValidatedFlight = await service.validateFlight("BA74", "2025-12-25");
      // Should have city but not name
      expect(result.destinationName).toBeUndefined();
      expect(result.destinationCity).toBe("Lagos");
    });

    it("should handle undefined airport info in scheduled flights", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          scheduled: [
            {
              ident: "BA74",
              ident_iata: "BA74",
              fa_flight_id: "BA74-scheduled",
              origin: "LHR",
              origin_iata: "LHR",
              destination: "LOS",
              destination_iata: "LOS",
              scheduled_in: "2025-12-30T14:00:00Z",
            },
          ],
        },
      });

      // Mock airport info fetch returning undefined fields
      mockHttpClient.get.mockResolvedValueOnce({
        data: {}, // Empty response or missing name/city
      });

      // Mock origin airport info fetch
      mockHttpClient.get.mockResolvedValueOnce({
        data: {},
      });

      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));

      const result: ValidatedFlight = await service.validateFlight("BA74", "2025-12-30");
      // destinationName and destinationCity should be undefined when airport info is not available
      expect(result.destinationName).toBeUndefined();
      expect(result.destinationCity).toBeUndefined();
      expect(result.destination).toBe("LOS");
    });

    it("should throw FlightAwareApiException for schedules API authentication errors (flights > 2 days)", async () => {
      // Flight > 2 days in future uses schedules API
      const axiosError = createAxiosErrorWithResponse(HttpStatus.UNAUTHORIZED, {
        message: "Invalid API key",
      });
      mockHttpClient.get.mockRejectedValueOnce(axiosError);

      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));

      await expect(service.validateFlight("BA74", "2025-12-30")).rejects.toThrow(
        FlightAwareApiException,
      );

      // Verify schedules API was called (not live API)
      expect(mockHttpClient.get).toHaveBeenCalledWith(expect.stringContaining("/schedules/"));
    });

    it("should throw FlightAwareApiException for schedules API rate limit errors (flights > 2 days)", async () => {
      // Flight > 2 days in future uses schedules API
      const axiosError = createAxiosErrorWithResponse(HttpStatus.TOO_MANY_REQUESTS, {
        message: "Rate limit exceeded",
      });
      mockHttpClient.get.mockRejectedValueOnce(axiosError);

      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));

      await expect(service.validateFlight("BA74", "2025-12-30")).rejects.toThrow(
        FlightAwareApiException,
      );

      // Verify schedules API was called (not live API)
      expect(mockHttpClient.get).toHaveBeenCalledWith(expect.stringContaining("/schedules/"));
    });

    it("should treat DNMM destination as LOS for already-landed detection", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          flights: [
            {
              ident: "BA74",
              fa_flight_id: "BA74-123",
              origin: { code: "LHR", code_iata: "LHR" },
              destination: { code: "DNMM" },
              scheduled_on: "2025-12-25T10:00:00Z",
              actual_on: "2025-12-25T12:00:00Z",
              status: "Arrived",
            },
          ],
        },
      });

      vi.setSystemTime(new Date("2025-12-25T13:00:00Z"));

      await expect(service.validateFlight("BA74", "2025-12-25")).rejects.toThrow(
        FlightAlreadyLandedException,
      );
    });

    it("should treat empty destination IATA as missing and fallback DNMM to LOS for already-landed detection", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          flights: [
            {
              ident: "BA74",
              fa_flight_id: "BA74-123",
              origin: { code: "LHR", code_iata: "LHR" },
              destination: { code: "DNMM", code_iata: "" },
              scheduled_on: "2025-12-25T10:00:00Z",
              actual_on: "2025-12-25T12:00:00Z",
              status: "Arrived",
            },
          ],
        },
      });

      vi.setSystemTime(new Date("2025-12-25T13:00:00Z"));

      await expect(service.validateFlight("BA74", "2025-12-25")).rejects.toThrow(
        FlightAlreadyLandedException,
      );
    });
  });

  describe("searchAirportPickupFlight", () => {
    it("should throw NON_LAGOS_DESTINATION when flight does not arrive in Lagos", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          flights: [
            {
              ident: "BA74",
              fa_flight_id: "BA74-123",
              origin: { code: "LHR", code_iata: "LHR" },
              destination: { code: "KJFK", code_iata: "JFK" },
              scheduled_on: "2025-12-25T14:00:00Z",
              estimated_on: "2025-12-25T14:30:00Z",
              status: "Scheduled",
            },
          ],
        },
      });

      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));

      const error = await service
        .searchAirportPickupFlight("BA74", "2025-12-25")
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(FlightNonLagosDestinationException);
      expect((error as FlightNonLagosDestinationException).getErrorCode()).toBe(
        "NON_LAGOS_DESTINATION",
      );
    });

    it("should allow pickup when destination IATA is missing but ICAO is DNMM", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          flights: [
            {
              ident: "BA74",
              fa_flight_id: "BA74-123",
              origin: { code: "LHR", code_iata: "LHR" },
              destination: { code: "DNMM" },
              scheduled_on: "2025-12-25T14:00:00Z",
              estimated_on: "2025-12-25T14:30:00Z",
              status: "En Route",
            },
          ],
        },
      });

      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));

      const result = await service.searchAirportPickupFlight("BA74", "2025-12-25");

      expect(result.flight.destination).toBe("DNMM");
      expect(result.flight.destinationIATA).toBeUndefined();
    });

    it("should allow pickup when destination IATA is empty and ICAO is DNMM", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: {
          flights: [
            {
              ident: "BA74",
              fa_flight_id: "BA74-123",
              origin: { code: "LHR", code_iata: "LHR" },
              destination: { code: "DNMM", code_iata: "" },
              scheduled_on: "2025-12-25T14:00:00Z",
              estimated_on: "2025-12-25T14:30:00Z",
              status: "En Route",
            },
          ],
        },
      });

      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));

      const result = await service.searchAirportPickupFlight("BA74", "2025-12-25");
      expect(result.flight).not.toBeNull();
      if (result.flight) {
        expect(result.flight.destination).toBe("DNMM");
        expect(result.flight.destinationIATA).toBe("");
      }
    });
  });
});
