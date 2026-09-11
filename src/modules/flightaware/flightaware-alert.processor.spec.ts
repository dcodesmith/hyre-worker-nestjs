import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { CREATE_FLIGHT_ALERT_JOB, FLIGHT_ALERTS_QUEUE } from "../../config/constants";
import { captureException } from "../../sentry";
import { captureTerminalJobFailure } from "../infra/queue-infra/bullmq-telemetry";

const { captureExceptionMock, captureTerminalJobFailureMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  captureTerminalJobFailureMock: vi.fn(),
}));

vi.mock("../../sentry", () => ({
  captureException: captureExceptionMock,
}));

vi.mock("../infra/queue-infra/bullmq-telemetry", () => ({
  captureTerminalJobFailure: captureTerminalJobFailureMock,
}));

import type { FlightAlertJobData } from "./flightaware-alert.interface";
import { FlightAlertProcessor } from "./flightaware-alert.processor";
import { FlightAwareAlertService } from "./flightaware-alert.service";

describe("FlightAlertProcessor", () => {
  let processor: FlightAlertProcessor;
  let flightAwareAlertService: FlightAwareAlertService;

  const mockJobData: FlightAlertJobData = {
    flightId: "flight-123",
    flightNumber: "BA74",
    departureTime: "2025-12-25T10:00:00.000Z",
    originCode: "EGLL",
    originTimezone: "Europe/London",
    destinationIATA: "LOS",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightAlertProcessor,
        {
          provide: FlightAwareAlertService,
          useValue: {
            getOrCreateFlightAlert: vi.fn(),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    processor = module.get<FlightAlertProcessor>(FlightAlertProcessor);
    flightAwareAlertService = module.get<FlightAwareAlertService>(FlightAwareAlertService);
  });
  describe("process", () => {
    it("should call getOrCreateFlightAlert with correct params", async () => {
      const job = {
        id: "job-123",
        name: CREATE_FLIGHT_ALERT_JOB,
        data: mockJobData,
      } as Job<FlightAlertJobData, void, string>;

      vi.mocked(flightAwareAlertService.getOrCreateFlightAlert).mockResolvedValue("alert-456");

      const result = await processor.process(job);

      expect(result).toEqual({ success: true });
      expect(flightAwareAlertService.getOrCreateFlightAlert).toHaveBeenCalledWith("flight-123", {
        flightNumber: "BA74",
        departureTime: new Date("2025-12-25T10:00:00.000Z"),
        originCode: "EGLL",
        originTimezone: "Europe/London",
        destinationIATA: "LOS",
      });
    });

    it("should pass undefined destinationIATA when not provided", async () => {
      const jobData: FlightAlertJobData = {
        flightId: "flight-789",
        flightNumber: "AA100",
        departureTime: "2025-12-25T10:00:00.000Z",
      };

      const job = {
        id: "job-456",
        name: CREATE_FLIGHT_ALERT_JOB,
        data: jobData,
      } as Job<FlightAlertJobData, void, string>;

      vi.mocked(flightAwareAlertService.getOrCreateFlightAlert).mockResolvedValue("alert-789");

      const result = await processor.process(job);

      expect(result).toEqual({ success: true });
      expect(flightAwareAlertService.getOrCreateFlightAlert).toHaveBeenCalledWith("flight-789", {
        flightNumber: "AA100",
        departureTime: new Date("2025-12-25T10:00:00.000Z"),
        originCode: undefined,
        originTimezone: undefined,
        destinationIATA: undefined,
      });
    });

    it("should throw error for unknown job type", async () => {
      const job = {
        id: "job-123",
        name: "unknown-job-type",
        data: mockJobData,
      } as Job<FlightAlertJobData, void, string>;

      await expect(processor.process(job)).rejects.toThrow(
        "Unknown flight alert job type: unknown-job-type",
      );
      expect(flightAwareAlertService.getOrCreateFlightAlert).not.toHaveBeenCalled();
    });

    it("should re-throw errors to trigger retry mechanism", async () => {
      const job = {
        id: "job-123",
        name: CREATE_FLIGHT_ALERT_JOB,
        data: mockJobData,
      } as Job<FlightAlertJobData, void, string>;

      vi.mocked(flightAwareAlertService.getOrCreateFlightAlert).mockRejectedValue(
        new Error("FlightAware API rate limit exceeded"),
      );

      await expect(processor.process(job)).rejects.toThrow("FlightAware API rate limit exceeded");
    });
  });

  describe("onFailed", () => {
    it("delegates a missing-job worker failure to terminal capture", () => {
      const error = new Error("job lost");

      processor.onFailed(undefined, error);

      expect(captureTerminalJobFailure).toHaveBeenCalledExactlyOnceWith(
        undefined,
        error,
        FLIGHT_ALERTS_QUEUE,
      );
      expect(captureException).not.toHaveBeenCalled();
    });

    it("delegates job failures to terminal-only capture", () => {
      const job = {
        id: "job-123",
        name: CREATE_FLIGHT_ALERT_JOB,
        data: mockJobData,
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as Job<FlightAlertJobData>;
      const error = new Error("FlightAware API rate limit exceeded");

      processor.onFailed(job, error);

      expect(captureTerminalJobFailure).toHaveBeenCalledExactlyOnceWith(
        job,
        error,
        FLIGHT_ALERTS_QUEUE,
      );
      expect(captureException).not.toHaveBeenCalled();
    });
  });
});
