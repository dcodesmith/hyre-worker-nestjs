import { HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import {
  createAxiosErrorWithResponse,
  createMockAxiosInstance,
  createMockHttpClientService,
} from "../http-client/http-client.fixtures";
import { HttpClientService } from "../http-client/http-client.service";
import type { FlightValidationResult } from "./flightaware.interface";
import { FlightAwareService } from "./flightaware.service";

// Helper functions for type-safe assertions on discriminated unions
function assertErrorResult(
  result: FlightValidationResult,
): asserts result is Extract<FlightValidationResult, { type: "error" }> {
  expect(result.type).toBe("error");
}

function assertSuccessResult(
  result: FlightValidationResult,
): asserts result is Extract<FlightValidationResult, { type: "success" }> {
  expect(result.type).toBe("success");
}

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

  const mockDatabaseService = {
    flight: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn((callback) => callback(mockDatabaseService)),
    $executeRaw: vi.fn(),
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
        { provide: DatabaseService, useValue: mockDatabaseService },
        { provide: HttpClientService, useValue: mockHttpClientService },
      ],
    }).compile();

    service = module.get<FlightAwareService>(FlightAwareService);
  });

  afterEach(() => {
    // Clean up the interval before switching to real timers
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
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
    it("should return error for invalid flight number format", async () => {
      const result = await service.validateFlight("INVALID", "2025-12-25");

      assertErrorResult(result);
      expect(result.message).toContain("Invalid flight number format");
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
      expect(result1.type).toBe("success");
      expect(mockHttpClient.get).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      const result2 = await service.validateFlight("BA74", "2025-12-25");
      expect(result2.type).toBe("success");
      expect(mockHttpClient.get).toHaveBeenCalledTimes(1); // Still 1, cache hit
    });

    it("should return notFound when no flights match", async () => {
      // Mock both IATA and ICAO attempts returning empty
      mockHttpClient.get.mockResolvedValueOnce({
        data: { flights: [] },
      });
      mockHttpClient.get.mockResolvedValueOnce({
        data: { flights: [] },
      });

      vi.setSystemTime(new Date("2025-12-24T10:00:00Z"));

      const result = await service.validateFlight("BA74", "2025-12-25");
      expect(result.type).toBe("notFound");
    });

    it("should return error result for API authentication errors", async () => {
      const axiosError = createAxiosErrorWithResponse(HttpStatus.UNAUTHORIZED, {
        message: "Invalid API key",
      });
      mockHttpClient.get.mockRejectedValueOnce(axiosError);

      vi.setSystemTime(new Date("2025-12-24T10:00:00Z"));

      // validateFlight catches errors and returns an error result
      const result = await service.validateFlight("BA74", "2025-12-25");
      assertErrorResult(result);
      expect(result.message).toBe("FlightAware API authentication failed");
    });

    it("should return error result for API rate limit errors", async () => {
      const axiosError = createAxiosErrorWithResponse(HttpStatus.TOO_MANY_REQUESTS, {
        message: "Rate limit exceeded",
      });
      mockHttpClient.get.mockRejectedValueOnce(axiosError);

      vi.setSystemTime(new Date("2025-12-24T10:00:00Z"));

      // validateFlight catches errors and returns an error result
      const result = await service.validateFlight("BA74", "2025-12-25");
      assertErrorResult(result);
      expect(result.message).toBe("FlightAware API rate limit exceeded");
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
              scheduled_in: "2025-12-30T14:00:00Z",
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
      expect(result.type).toBe("success");

      // Verify schedules API was called
      expect(mockHttpClient.get).toHaveBeenCalledWith(expect.stringContaining("/schedules/"));
    });

    it("should handle undefined destination name and city without showing 'undefined'", async () => {
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

      const result = await service.validateFlight("BA74", "2025-12-25");
      assertSuccessResult(result);
      // arrivalAddress should fall back to code when name and city are undefined
      expect(result.flight.arrivalAddress).toBe("LOS");
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

      const result = await service.validateFlight("BA74", "2025-12-25");
      assertSuccessResult(result);
      // Should only show city, not "undefined, Lagos"
      expect(result.flight.arrivalAddress).toBe("Lagos");
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

      vi.setSystemTime(new Date("2025-12-25T10:00:00Z"));

      const result = await service.validateFlight("BA74", "2025-12-30");
      assertSuccessResult(result);
      // arrivalAddress should fall back to code when airport info is not available
      expect(result.flight.arrivalAddress).toBe("LOS");
    });
  });

  describe("createFlightAlert", () => {
    it("should create an alert and return alert ID", async () => {
      mockHttpClient.post.mockResolvedValueOnce({
        data: {
          alert_id: "alert-123",
          ident: "BA74",
          enabled: true,
          events: ["arrival", "departure"],
        },
      });

      const result = await service.createFlightAlert({
        flightNumber: "BA74",
        flightDate: new Date("2025-12-25"),
        destinationIATA: "LOS",
      });

      expect(result).toBe("alert-123");
      expect(mockHttpClient.post).toHaveBeenCalledWith(
        "/alerts",
        expect.objectContaining({
          ident: "BA74",
          enabled: true,
        }),
      );
    });

    it("should include destination in request body when provided", async () => {
      mockHttpClient.post.mockResolvedValueOnce({
        data: {
          alert_id: "alert-123",
          ident: "BA74",
          enabled: true,
          events: ["arrival"],
        },
      });

      await service.createFlightAlert({
        flightNumber: "BA74",
        flightDate: new Date("2025-12-25"),
        destinationIATA: "LOS",
        events: ["arrival"],
      });

      expect(mockHttpClient.post).toHaveBeenCalledWith(
        "/alerts",
        expect.objectContaining({
          destination: "LOS",
        }),
      );
    });

    it("should throw on authentication error", async () => {
      const axiosError = createAxiosErrorWithResponse(HttpStatus.UNAUTHORIZED, {
        message: "Invalid API key",
      });
      mockHttpClient.post.mockRejectedValueOnce(axiosError);

      await expect(
        service.createFlightAlert({
          flightNumber: "BA74",
          flightDate: new Date("2025-12-25"),
        }),
      ).rejects.toThrow("FlightAware API authentication failed");
    });

    it("should throw on rate limit error", async () => {
      const axiosError = createAxiosErrorWithResponse(HttpStatus.TOO_MANY_REQUESTS, {
        message: "Rate limit exceeded",
      });
      mockHttpClient.post.mockRejectedValueOnce(axiosError);

      await expect(
        service.createFlightAlert({
          flightNumber: "BA74",
          flightDate: new Date("2025-12-25"),
        }),
      ).rejects.toThrow("FlightAware API rate limit exceeded");
    });
  });

  describe("getOrCreateFlightAlert", () => {
    it("should return existing alert ID if flight already has one", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: "existing-alert-123",
        alertEnabled: true,
      });

      const result = await service.getOrCreateFlightAlert("flight-id-1", {
        flightNumber: "BA74",
        flightDate: new Date("2025-12-25"),
      });

      expect(result).toBe("existing-alert-123");
      expect(mockHttpClient.post).not.toHaveBeenCalled();
    });

    it("should create new alert if flight has no active alert", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: null,
        alertEnabled: false,
      });

      mockHttpClient.post.mockResolvedValueOnce({
        data: {
          alert_id: "new-alert-456",
          ident: "BA74",
          enabled: true,
          events: ["arrival"],
        },
      });

      mockDatabaseService.flight.update.mockResolvedValueOnce({});

      const result = await service.getOrCreateFlightAlert("flight-id-1", {
        flightNumber: "BA74",
        flightDate: new Date("2025-12-25"),
      });

      expect(result).toBe("new-alert-456");
      expect(mockDatabaseService.flight.update).toHaveBeenCalledWith({
        where: { id: "flight-id-1" },
        data: { alertId: "new-alert-456", alertEnabled: true },
      });
    });

    it("should use advisory lock to prevent race conditions", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: "existing-alert",
        alertEnabled: true,
      });

      await service.getOrCreateFlightAlert("flight-id-1", {
        flightNumber: "BA74",
        flightDate: new Date("2025-12-25"),
      });

      // Verify both lock and unlock were called
      expect(mockDatabaseService.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it("should throw error if flight does not exist in database without calling external API", async () => {
      // Flight doesn't exist in database
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.getOrCreateFlightAlert("non-existent-flight-id", {
          flightNumber: "BA74",
          flightDate: new Date("2025-12-25"),
        }),
      ).rejects.toThrow("Flight with id non-existent-flight-id not found in database");

      // Verify external API was NOT called (prevents orphaned alerts)
      expect(mockHttpClient.post).not.toHaveBeenCalled();
    });
  });

  describe("disableFlightAlert", () => {
    it("should delete alert via API", async () => {
      mockHttpClient.delete.mockResolvedValueOnce({});

      await service.disableFlightAlert("alert-123");

      expect(mockHttpClient.delete).toHaveBeenCalledWith("/alerts/alert-123");
    });

    it("should not throw on 404 (alert already deleted)", async () => {
      const axiosError = createAxiosErrorWithResponse(HttpStatus.NOT_FOUND, {
        message: "Not found",
      });
      mockHttpClient.delete.mockRejectedValueOnce(axiosError);

      await expect(service.disableFlightAlert("alert-123")).resolves.not.toThrow();
    });

    it("should throw on authentication error", async () => {
      const axiosError = createAxiosErrorWithResponse(HttpStatus.UNAUTHORIZED, {
        message: "Invalid API key",
      });
      mockHttpClient.delete.mockRejectedValueOnce(axiosError);

      await expect(service.disableFlightAlert("alert-123")).rejects.toThrow(
        "FlightAware API authentication failed",
      );
    });
  });

  describe("cleanupFlightAlert", () => {
    it("should delete alert and update flight record", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: "alert-123",
        alertEnabled: true,
      });

      mockHttpClient.delete.mockResolvedValueOnce({});
      mockDatabaseService.flight.update.mockResolvedValueOnce({});

      await service.cleanupFlightAlert("flight-id-1");

      expect(mockHttpClient.delete).toHaveBeenCalledWith("/alerts/alert-123");
      expect(mockDatabaseService.flight.update).toHaveBeenCalledWith({
        where: { id: "flight-id-1" },
        data: { alertEnabled: false },
      });
    });

    it("should do nothing if flight has no active alert", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: null,
        alertEnabled: false,
      });

      await service.cleanupFlightAlert("flight-id-1");

      expect(mockHttpClient.delete).not.toHaveBeenCalled();
      expect(mockDatabaseService.flight.update).not.toHaveBeenCalled();
    });

    it("should do nothing if alert is disabled", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: "alert-123",
        alertEnabled: false,
      });

      await service.cleanupFlightAlert("flight-id-1");

      expect(mockHttpClient.delete).not.toHaveBeenCalled();
    });

    it("should not update database when API call fails", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: "alert-123",
        alertEnabled: true,
      });

      const axiosError = createAxiosErrorWithResponse(HttpStatus.INTERNAL_SERVER_ERROR, {
        message: "Server error",
      });
      mockHttpClient.delete.mockRejectedValueOnce(axiosError);

      await expect(service.cleanupFlightAlert("flight-id-1")).rejects.toThrow();

      expect(mockHttpClient.delete).toHaveBeenCalledWith("/alerts/alert-123");
      expect(mockDatabaseService.flight.update).not.toHaveBeenCalled();
    });

    it("should propagate auth errors without updating database", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: "alert-123",
        alertEnabled: true,
      });

      const axiosError = createAxiosErrorWithResponse(HttpStatus.UNAUTHORIZED, {
        message: "Unauthorized",
      });
      mockHttpClient.delete.mockRejectedValueOnce(axiosError);

      await expect(service.cleanupFlightAlert("flight-id-1")).rejects.toThrow(
        "FlightAware API authentication failed",
      );

      expect(mockDatabaseService.flight.update).not.toHaveBeenCalled();
    });
  });
});
