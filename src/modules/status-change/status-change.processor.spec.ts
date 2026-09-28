import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  ACTIVATE_AIRPORT_BOOKING,
  ACTIVE_TO_COMPLETED,
  CONFIRMED_TO_ACTIVE,
  STATUS_UPDATES_QUEUE,
} from "../../config/constants";
import { captureTerminalJobFailure } from "../infra/queue-infra/bullmq-telemetry";

const { captureTerminalJobFailureMock } = vi.hoisted(() => ({
  captureTerminalJobFailureMock: vi.fn(),
}));

vi.mock("../infra/queue-infra/bullmq-telemetry", () => ({
  captureTerminalJobFailure: captureTerminalJobFailureMock,
}));

import {
  InvalidStatusUpdateJobPayloadException,
  UnknownStatusUpdateJobTypeException,
} from "./status-change.error";
import { StatusUpdateJobData } from "./status-change.interface";
import { StatusChangeProcessor } from "./status-change.processor";
import { StatusChangeService } from "./status-change.service";

describe("StatusChangeProcessor", () => {
  let processor: StatusChangeProcessor;
  let statusChangeService: StatusChangeService;
  let logger: PinoLogger;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusChangeProcessor,
        {
          provide: StatusChangeService,
          useValue: {
            updateBookingsFromConfirmedToActive: vi.fn(),
            updateBookingsFromActiveToCompleted: vi.fn(),
            activateAirportBooking: vi.fn(),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    processor = module.get<StatusChangeProcessor>(StatusChangeProcessor);
    statusChangeService = module.get<StatusChangeService>(StatusChangeService);
    logger = module.get<PinoLogger>(PinoLogger);
  });

  it("should throw error for unknown job type", async () => {
    const job = {
      id: "job-5",
      name: "unknown-job-type",
      data: { type: CONFIRMED_TO_ACTIVE, timestamp: new Date().toISOString() },
    } as Job<StatusUpdateJobData, { success: boolean; result?: string }, string>;

    await expect(processor.process(job)).rejects.toBeInstanceOf(
      UnknownStatusUpdateJobTypeException,
    );
  });

  it("should pass trimmed bookingId to activateAirportBooking", async () => {
    const activationAt = new Date().toISOString();
    const job = {
      id: "job-trim-booking",
      name: ACTIVATE_AIRPORT_BOOKING,
      data: {
        type: ACTIVATE_AIRPORT_BOOKING,
        bookingId: "  booking-airport-trim  ",
        activationAt,
      },
    } as Job<StatusUpdateJobData, { success: boolean; result?: string }, string>;

    vi.mocked(statusChangeService.activateAirportBooking).mockResolvedValueOnce(
      "Activated airport booking booking-airport-trim",
    );

    await processor.process(job);

    expect(statusChangeService.activateAirportBooking).toHaveBeenCalledExactlyOnceWith(
      "booking-airport-trim",
      activationAt,
    );
  });

  it("should throw invalid payload error when job.name and data.type do not match", async () => {
    const job = {
      id: "job-9",
      name: ACTIVE_TO_COMPLETED,
      data: {
        type: ACTIVATE_AIRPORT_BOOKING,
        bookingId: "booking-airport-1",
        activationAt: new Date().toISOString(),
      },
    } as unknown as Job<StatusUpdateJobData, { success: boolean; result?: string }, string>;

    await expect(processor.process(job)).rejects.toBeInstanceOf(
      InvalidStatusUpdateJobPayloadException,
    );
  });

  it("should throw invalid payload error when job data is malformed", async () => {
    const job = {
      id: "job-10",
      name: ACTIVE_TO_COMPLETED,
      data: null,
    } as unknown as Job<StatusUpdateJobData, { success: boolean; result?: string }, string>;

    await expect(processor.process(job)).rejects.toBeInstanceOf(
      InvalidStatusUpdateJobPayloadException,
    );
    expect(statusChangeService.updateBookingsFromActiveToCompleted).not.toHaveBeenCalled();
  });

  it.each([
    {
      jobName: CONFIRMED_TO_ACTIVE,
      data: { type: CONFIRMED_TO_ACTIVE, timestamp: 123 },
    },
    {
      jobName: ACTIVE_TO_COMPLETED,
      data: { type: ACTIVE_TO_COMPLETED, timestamp: 123 },
    },
    {
      jobName: ACTIVATE_AIRPORT_BOOKING,
      data: { type: ACTIVATE_AIRPORT_BOOKING },
    },
    {
      jobName: ACTIVATE_AIRPORT_BOOKING,
      data: { type: ACTIVATE_AIRPORT_BOOKING, bookingId: 123 },
    },
    {
      jobName: ACTIVATE_AIRPORT_BOOKING,
      data: { type: ACTIVATE_AIRPORT_BOOKING, bookingId: "   " },
    },
    {
      jobName: ACTIVATE_AIRPORT_BOOKING,
      data: { type: ACTIVATE_AIRPORT_BOOKING, bookingId: "booking-1", activationAt: 123 },
    },
  ])(
    "should throw invalid payload error for malformed $jobName payload",
    async ({ jobName, data }) => {
      const job = {
        id: "job-malformed-variant",
        name: jobName,
        data,
      } as unknown as Job<StatusUpdateJobData, { success: boolean; result?: string }, string>;

      await expect(processor.process(job)).rejects.toBeInstanceOf(
        InvalidStatusUpdateJobPayloadException,
      );
      expect(statusChangeService.updateBookingsFromConfirmedToActive).not.toHaveBeenCalled();
      expect(statusChangeService.updateBookingsFromActiveToCompleted).not.toHaveBeenCalled();
      expect(statusChangeService.activateAirportBooking).not.toHaveBeenCalled();
    },
  );

  it("captures a missing-job worker failure without dereferencing the job", () => {
    vi.clearAllMocks();
    const error = new Error("job lost");

    expect(() => processor.onFailed(undefined, error)).not.toThrow();

    expect(captureTerminalJobFailure).toHaveBeenCalledExactlyOnceWith(
      undefined,
      error,
      STATUS_UPDATES_QUEUE,
    );
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      { error: error.message, stack: error.stack },
      "Job failed without context",
    );
  });
});
