import { HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import {
  createAxiosErrorWithResponse,
  createMockAxiosInstance,
  createMockHttpClientService,
} from "../http-client/http-client.fixtures";
import { HttpClientService } from "../http-client/http-client.service";
import { FlightAwareApiException, FlightRecordNotFoundException } from "./flightaware.error";
import { FlightAwareAlertService } from "./flightaware-alert.service";

describe("FlightAwareAlertService", () => {
  let service: FlightAwareAlertService;
  let mockHttpClient: ReturnType<typeof createMockAxiosInstance>;

  const mockConfigService = {
    get: vi.fn((key: string) => {
      if (key === "FLIGHTAWARE_API_KEY") return "test-api-key";
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

    mockHttpClient = createMockAxiosInstance();
    mockHttpClientService = createMockHttpClientService(mockHttpClient);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightAwareAlertService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DatabaseService, useValue: mockDatabaseService },
        { provide: HttpClientService, useValue: mockHttpClientService },
      ],
    }).compile();

    service = module.get<FlightAwareAlertService>(FlightAwareAlertService);
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
      ).rejects.toThrow(FlightAwareApiException);
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
      ).rejects.toThrow(FlightAwareApiException);
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

      expect(mockDatabaseService.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it("should throw error if flight does not exist in database without calling external API", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.getOrCreateFlightAlert("non-existent-flight-id", {
          flightNumber: "BA74",
          flightDate: new Date("2025-12-25"),
        }),
      ).rejects.toThrow(FlightRecordNotFoundException);

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
        FlightAwareApiException,
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
        FlightAwareApiException,
      );

      expect(mockDatabaseService.flight.update).not.toHaveBeenCalled();
    });
  });
});
