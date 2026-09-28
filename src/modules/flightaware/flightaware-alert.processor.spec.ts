import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";

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
  });
});
