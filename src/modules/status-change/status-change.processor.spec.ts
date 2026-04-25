import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVATE_AIRPORT_BOOKING,
  ACTIVE_TO_COMPLETED,
  CONFIRMED_TO_ACTIVE,
} from "../../config/constants";
import {
  InvalidStatusUpdateJobPayloadException,
  StatusUpdateJobProcessingFailedException,
  UnknownStatusUpdateJobTypeException,
} from "./status-change.error";
import { StatusUpdateJobData } from "./status-change.interface";
import { StatusChangeProcessor } from "./status-change.processor";
import { StatusChangeService } from "./status-change.service";

describe("StatusChangeProcessor", () => {
  let processor: StatusChangeProcessor;
  let statusChangeService: StatusChangeService;

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
    }).compile();

    processor = module.get<StatusChangeProcessor>(StatusChangeProcessor);
    statusChangeService = module.get<StatusChangeService>(StatusChangeService);
  });

  it("should process CONFIRMED_TO_ACTIVE job and call updateBookingsFromConfirmedToActive", async () => {
    const timestamp = new Date().toISOString();
    const job = {
      id: "job-1",
      name: CONFIRMED_TO_ACTIVE,
      data: { type: CONFIRMED_TO_ACTIVE, timestamp },
    } as Job<StatusUpdateJobData, { success: boolean; result?: string }, string>;

    vi.mocked(statusChangeService.updateBookingsFromConfirmedToActive).mockResolvedValueOnce(
      "Updated 5 bookings from confirmed to active",
    );

    const result = await processor.process(job);

    expect(statusChangeService.updateBookingsFromConfirmedToActive).toHaveBeenCalledExactlyOnceWith(
      timestamp,
    );
    expect(result).toEqual({
      success: true,
      result: "Updated 5 bookings from confirmed to active",
    });
  });

  it("should process CONFIRMED_TO_ACTIVE job without timestamp", async () => {
    const job = {
      id: "job-2",
      name: CONFIRMED_TO_ACTIVE,
      data: { type: CONFIRMED_TO_ACTIVE },
    } as Job<StatusUpdateJobData, { success: boolean; result?: string }, string>;

    vi.mocked(statusChangeService.updateBookingsFromConfirmedToActive).mockResolvedValueOnce(
      "No bookings to update",
    );

    const result = await processor.process(job);

    expect(statusChangeService.updateBookingsFromConfirmedToActive).toHaveBeenCalledExactlyOnceWith(
      undefined,
    );
    expect(result).toEqual({ success: true, result: "No bookings to update" });
  });

  it("should process ACTIVE_TO_COMPLETED job and call updateBookingsFromActiveToCompleted", async () => {
    const timestamp = new Date().toISOString();
    const job = {
      id: "job-3",
      name: ACTIVE_TO_COMPLETED,
      data: { type: ACTIVE_TO_COMPLETED, timestamp },
    } as Job<StatusUpdateJobData, { success: boolean; result?: string }, string>;

    vi.mocked(statusChangeService.updateBookingsFromActiveToCompleted).mockResolvedValueOnce(
      "Updated 3 bookings from active to completed",
    );

    const result = await processor.process(job);

    expect(statusChangeService.updateBookingsFromActiveToCompleted).toHaveBeenCalledExactlyOnceWith(
      timestamp,
    );
    expect(result).toEqual({
      success: true,
      result: "Updated 3 bookings from active to completed",
    });
  });

  it("should process ACTIVE_TO_COMPLETED job without timestamp", async () => {
    const job = {
      id: "job-4",
      name: ACTIVE_TO_COMPLETED,
      data: { type: ACTIVE_TO_COMPLETED },
    } as Job<StatusUpdateJobData, { success: boolean; result?: string }, string>;

    vi.mocked(statusChangeService.updateBookingsFromActiveToCompleted).mockResolvedValueOnce(
      "No bookings to update",
    );

    const result = await processor.process(job);

    expect(statusChangeService.updateBookingsFromActiveToCompleted).toHaveBeenCalledExactlyOnceWith(
      undefined,
    );
    expect(result).toEqual({ success: true, result: "No bookings to update" });
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

  it("should process ACTIVATE_AIRPORT_BOOKING job and call activateAirportBooking", async () => {
    const activationAt = new Date().toISOString();
    const job = {
      id: "job-8",
      name: ACTIVATE_AIRPORT_BOOKING,
      data: {
        type: ACTIVATE_AIRPORT_BOOKING,
        bookingId: "booking-airport-1",
        activationAt,
      },
    } as Job<StatusUpdateJobData, { success: boolean; result?: string }, string>;

    vi.mocked(statusChangeService.activateAirportBooking).mockResolvedValueOnce(
      "Activated airport booking booking-airport-1",
    );

    const result = await processor.process(job);

    expect(statusChangeService.activateAirportBooking).toHaveBeenCalledExactlyOnceWith(
      "booking-airport-1",
      activationAt,
    );
    expect(result).toEqual({
      success: true,
      result: "Activated airport booking booking-airport-1",
    });
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

  it("should throw error when updateBookingsFromConfirmedToActive fails", async () => {
    const job = {
      id: "job-6",
      name: CONFIRMED_TO_ACTIVE,
      data: { type: CONFIRMED_TO_ACTIVE, timestamp: new Date().toISOString() },
    } as Job<StatusUpdateJobData, { success: boolean; result?: string }, string>;

    const serviceError = new Error("Database connection failed");
    vi.mocked(statusChangeService.updateBookingsFromConfirmedToActive).mockRejectedValueOnce(
      serviceError,
    );

    await expect(processor.process(job)).rejects.toBeInstanceOf(
      StatusUpdateJobProcessingFailedException,
    );
    expect(statusChangeService.updateBookingsFromConfirmedToActive).toHaveBeenCalled();
  });

  it("should throw error when updateBookingsFromActiveToCompleted fails", async () => {
    const job = {
      id: "job-7",
      name: ACTIVE_TO_COMPLETED,
      data: { type: ACTIVE_TO_COMPLETED, timestamp: new Date().toISOString() },
    } as Job<StatusUpdateJobData, { success: boolean; result?: string }, string>;

    const serviceError = new Error("Service unavailable");
    vi.mocked(statusChangeService.updateBookingsFromActiveToCompleted).mockRejectedValueOnce(
      serviceError,
    );

    await expect(processor.process(job)).rejects.toBeInstanceOf(
      StatusUpdateJobProcessingFailedException,
    );
    expect(statusChangeService.updateBookingsFromActiveToCompleted).toHaveBeenCalled();
  });
});
