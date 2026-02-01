import { Logger } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CREATE_FLIGHT_ALERT_JOB } from "../../config/constants";
import { FlightAwareService } from "./flightaware.service";
import type { FlightAlertJobData } from "./flightaware-alert.interface";
import { FlightAlertProcessor } from "./flightaware-alert.processor";

describe("FlightAlertProcessor", () => {
  let processor: FlightAlertProcessor;
  let flightAwareService: FlightAwareService;

  beforeAll(() => {
    Logger.overrideLogger([]);
  });

  afterAll(() => {
    Logger.overrideLogger(undefined);
  });

  const mockJobData: FlightAlertJobData = {
    flightId: "flight-123",
    flightNumber: "BA74",
    flightDate: "2025-12-25T10:00:00.000Z",
    destinationIATA: "LOS",
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightAlertProcessor,
        {
          provide: FlightAwareService,
          useValue: {
            getOrCreateFlightAlert: vi.fn(),
          },
        },
      ],
    }).compile();

    processor = module.get<FlightAlertProcessor>(FlightAlertProcessor);
    flightAwareService = module.get<FlightAwareService>(FlightAwareService);
  });

  it("should be defined", () => {
    expect(processor).toBeDefined();
  });

  describe("process", () => {
    it("should call getOrCreateFlightAlert with correct params", async () => {
      const job = {
        id: "job-123",
        name: CREATE_FLIGHT_ALERT_JOB,
        data: mockJobData,
      } as Job<FlightAlertJobData, void, string>;

      vi.mocked(flightAwareService.getOrCreateFlightAlert).mockResolvedValue("alert-456");

      const result = await processor.process(job);

      expect(result).toEqual({ success: true });
      expect(flightAwareService.getOrCreateFlightAlert).toHaveBeenCalledWith("flight-123", {
        flightNumber: "BA74",
        flightDate: new Date("2025-12-25T10:00:00.000Z"),
        destinationIATA: "LOS",
      });
    });

    it("should pass undefined destinationIATA when not provided", async () => {
      const jobData: FlightAlertJobData = {
        flightId: "flight-789",
        flightNumber: "AA100",
        flightDate: "2025-12-25T10:00:00.000Z",
      };

      const job = {
        id: "job-456",
        name: CREATE_FLIGHT_ALERT_JOB,
        data: jobData,
      } as Job<FlightAlertJobData, void, string>;

      vi.mocked(flightAwareService.getOrCreateFlightAlert).mockResolvedValue("alert-789");

      const result = await processor.process(job);

      expect(result).toEqual({ success: true });
      expect(flightAwareService.getOrCreateFlightAlert).toHaveBeenCalledWith("flight-789", {
        flightNumber: "AA100",
        flightDate: new Date("2025-12-25T10:00:00.000Z"),
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
      expect(flightAwareService.getOrCreateFlightAlert).not.toHaveBeenCalled();
    });

    it("should re-throw errors to trigger retry mechanism", async () => {
      const job = {
        id: "job-123",
        name: CREATE_FLIGHT_ALERT_JOB,
        data: mockJobData,
      } as Job<FlightAlertJobData, void, string>;

      vi.mocked(flightAwareService.getOrCreateFlightAlert).mockRejectedValue(
        new Error("FlightAware API rate limit exceeded"),
      );

      await expect(processor.process(job)).rejects.toThrow("FlightAware API rate limit exceeded");
    });
  });
});
