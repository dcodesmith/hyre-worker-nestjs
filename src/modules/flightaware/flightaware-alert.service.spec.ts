import { HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createHmacSignature } from "../../common/security/webhook-signature.helper";
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
      if (key === "AUTH_BASE_URL") return "https://api.example.com";
      if (key === "FLIGHTAWARE_WEBHOOK_SECRET") return "webhook-secret";
      return undefined;
    }),
  };

  const mockDatabaseService = {
    flight: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<FlightAwareAlertService>(FlightAwareAlertService);
  });

  describe("createFlightAlert", () => {
    it("should create an alert and return alert ID", async () => {
      mockHttpClient.post.mockResolvedValueOnce({
        data: undefined,
        headers: { location: "/aeroapi/alerts/123" },
      });

      const result = await service.createFlightAlert({
        flightId: "flight-1",
        flightNumber: "BA74",
        departureTime: new Date("2025-12-25T01:00:00.000Z"),
        originTimezone: "America/New_York",
        destinationIATA: "LOS",
      });

      expect(result).toBe("123");
      expect(mockHttpClient.post).toHaveBeenCalledWith("/alerts", {
        ident: "BA74",
        destination: "LOS",
        start: "2025-12-24",
        end: "2025-12-24",
        eta: 0,
        events: {
          arrival: true,
          cancelled: true,
          departure: true,
          diverted: true,
          filed: false,
          out: false,
          off: false,
          on: false,
          in: true,
        },
        target_url: `https://api.example.com/api/webhooks/flightaware?flightId=flight-1&signature=${createHmacSignature("flight-1", "webhook-secret")}`,
      });
    });

    it("resolves a missing origin timezone before calculating the alert date", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        data: { timezone: "America/New_York" },
      });
      mockHttpClient.post.mockResolvedValueOnce({
        data: undefined,
        headers: { location: "/aeroapi/alerts/124" },
      });

      await service.createFlightAlert({
        flightId: "flight-1",
        flightNumber: "BA74",
        departureTime: new Date("2025-12-25T01:00:00.000Z"),
        originCode: "KJFK",
        destinationIATA: "LOS",
      });

      expect(mockHttpClient.get).toHaveBeenCalledWith("/airports/KJFK");
      expect(mockHttpClient.post).toHaveBeenCalledWith(
        "/alerts",
        expect.objectContaining({
          start: "2025-12-24",
          end: "2025-12-24",
        }),
      );
    });

    it("should include destination in request body when provided", async () => {
      mockHttpClient.post.mockResolvedValueOnce({
        data: undefined,
        headers: { location: "/aeroapi/alerts/123" },
      });

      await service.createFlightAlert({
        flightId: "flight-1",
        flightNumber: "BA74",
        departureTime: new Date("2025-12-25"),
        originTimezone: "UTC",
        destinationIATA: "LOS",
      });

      expect(mockHttpClient.post).toHaveBeenCalledWith(
        "/alerts",
        expect.objectContaining({
          destination: "LOS",
        }),
      );
    });

    it("rejects a create response without an alert location", async () => {
      mockHttpClient.post.mockResolvedValueOnce({
        data: undefined,
        headers: {},
      });

      await expect(
        service.createFlightAlert({
          flightId: "flight-1",
          flightNumber: "BA74",
          departureTime: new Date("2025-12-25"),
          originTimezone: "UTC",
        }),
      ).rejects.toThrow("did not include an alert Location");
    });

    it("should throw on authentication error", async () => {
      const axiosError = createAxiosErrorWithResponse(HttpStatus.UNAUTHORIZED, {
        message: "Invalid API key",
      });
      mockHttpClient.post.mockRejectedValueOnce(axiosError);

      await expect(
        service.createFlightAlert({
          flightId: "flight-1",
          flightNumber: "BA74",
          departureTime: new Date("2025-12-25"),
          originTimezone: "UTC",
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
          flightId: "flight-1",
          flightNumber: "BA74",
          departureTime: new Date("2025-12-25"),
          originTimezone: "UTC",
        }),
      ).rejects.toThrow(FlightAwareApiException);
    });
  });

  describe("getOrCreateFlightAlert", () => {
    it("should return existing alert ID if flight already has one", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: "existing-alert-123",
        alertEnabled: true,
        alertProvisioningAt: null,
      });

      const result = await service.getOrCreateFlightAlert("flight-id-1", {
        flightNumber: "BA74",
        departureTime: new Date("2025-12-25"),
        originTimezone: "UTC",
      });

      expect(result).toBe("existing-alert-123");
      expect(mockHttpClient.post).not.toHaveBeenCalled();
    });

    it("should create new alert if flight has no active alert", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: null,
        alertEnabled: false,
        alertProvisioningAt: null,
      });

      mockHttpClient.post.mockResolvedValueOnce({
        data: undefined,
        headers: { location: "/aeroapi/alerts/456" },
      });

      const result = await service.getOrCreateFlightAlert("flight-id-1", {
        flightNumber: "BA74",
        departureTime: new Date("2025-12-25"),
        originTimezone: "UTC",
      });

      expect(result).toBe("456");
      expect(mockDatabaseService.flight.updateMany).toHaveBeenCalledWith({
        where: {
          id: "flight-id-1",
          alertEnabled: false,
          alertProvisioningAt: expect.any(Date),
        },
        data: {
          alertId: "456",
          alertEnabled: true,
          alertCreatedAt: expect.any(Date),
          alertDisabledAt: null,
          alertProvisioningAt: null,
        },
      });
    });

    it("creates the remote alert after releasing the claim transaction", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: null,
        alertEnabled: false,
        alertProvisioningAt: null,
      });
      mockHttpClient.post.mockResolvedValueOnce({
        data: undefined,
        headers: { location: "/aeroapi/alerts/456" },
      });
      mockDatabaseService.$transaction.mockImplementationOnce(async (callback) => {
        const result = await callback(mockDatabaseService);
        expect(mockHttpClient.post).not.toHaveBeenCalled();
        return result;
      });

      await service.getOrCreateFlightAlert("flight-id-1", {
        flightNumber: "BA74",
        departureTime: new Date("2025-12-25"),
        originTimezone: "UTC",
      });

      expect(mockHttpClient.post).toHaveBeenCalledOnce();
    });

    it("does not create a second alert while provisioning is active", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: null,
        alertEnabled: false,
        alertProvisioningAt: new Date(),
      });

      await expect(
        service.getOrCreateFlightAlert("flight-id-1", {
          flightNumber: "BA74",
          departureTime: new Date("2025-12-25"),
          originTimezone: "UTC",
        }),
      ).rejects.toThrow("provisioning is already in progress");

      expect(mockHttpClient.post).not.toHaveBeenCalled();
    });

    it("should use advisory lock to prevent race conditions", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: "existing-alert",
        alertEnabled: true,
        alertProvisioningAt: null,
      });

      await service.getOrCreateFlightAlert("flight-id-1", {
        flightNumber: "BA74",
        departureTime: new Date("2025-12-25"),
        originTimezone: "UTC",
      });

      expect(mockDatabaseService.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it("deletes a newly created remote alert when local persistence fails", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce({
        alertId: null,
        alertEnabled: false,
        alertProvisioningAt: null,
      });
      mockHttpClient.post.mockResolvedValueOnce({
        data: undefined,
        headers: { location: "/aeroapi/alerts/456" },
      });
      mockDatabaseService.flight.updateMany.mockRejectedValueOnce(
        new Error("Database unavailable"),
      );
      mockHttpClient.delete.mockResolvedValueOnce({});

      await expect(
        service.getOrCreateFlightAlert("flight-id-1", {
          flightNumber: "BA74",
          departureTime: new Date("2025-12-25"),
          originTimezone: "UTC",
        }),
      ).rejects.toThrow("Database unavailable");

      expect(mockHttpClient.delete).toHaveBeenCalledWith("/alerts/456");
    });

    it("should throw error if flight does not exist in database without calling external API", async () => {
      mockDatabaseService.flight.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.getOrCreateFlightAlert("non-existent-flight-id", {
          flightNumber: "BA74",
          departureTime: new Date("2025-12-25"),
          originTimezone: "UTC",
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
        data: {
          alertEnabled: false,
          alertCreatedAt: null,
          alertDisabledAt: expect.any(Date),
          alertProvisioningAt: null,
        },
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
