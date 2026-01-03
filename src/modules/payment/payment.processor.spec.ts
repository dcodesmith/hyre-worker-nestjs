import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus } from "@prisma/client";
import { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { PayoutJobData, PROCESS_PAYOUT_FOR_BOOKING } from "./payment.interface";
import { PaymentProcessor } from "./payment.processor";
import { PaymentService } from "./payment.service";

describe("PaymentProcessor", () => {
  let processor: PaymentProcessor;
  let databaseService: DatabaseService;
  let paymentService: PaymentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentProcessor,
        {
          provide: DatabaseService,
          useValue: {
            booking: {
              findUnique: vi.fn(),
            },
          },
        },
        {
          provide: PaymentService,
          useValue: {
            initiatePayout: vi.fn(),
          },
        },
      ],
    }).compile();

    processor = module.get<PaymentProcessor>(PaymentProcessor);
    databaseService = module.get<DatabaseService>(DatabaseService);
    paymentService = module.get<PaymentService>(PaymentService);
  });

  it("should process payout job and call initiatePayout when booking exists", async () => {
    const job = {
      id: "job-1",
      name: PROCESS_PAYOUT_FOR_BOOKING,
      data: { bookingId: "booking-1", timestamp: new Date().toISOString() },
    } as Job<PayoutJobData, any, string>;

    vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(
      createBooking({ id: "booking-1", status: BookingStatus.COMPLETED }),
    );

    const result = await processor.process(job);

    expect(databaseService.booking.findUnique).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      include: expect.any(Object),
    });
    expect(paymentService.initiatePayout).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "booking-1" }),
    );
    expect(result).toEqual({ success: true });
  });

  it("should not call initiatePayout when booking is not found", async () => {
    const job = {
      id: "job-2",
      name: PROCESS_PAYOUT_FOR_BOOKING,
      data: { bookingId: "missing-booking", timestamp: new Date().toISOString() },
    } as Job<PayoutJobData, any, string>;

    vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(null);

    const result = await processor.process(job);

    expect(paymentService.initiatePayout).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, reason: "BOOKING_NOT_FOUND" });
  });

  it("should throw error for unknown job type", async () => {
    const job = {
      id: "job-3",
      name: "unknown-job-type",
      data: { bookingId: "booking-1", timestamp: new Date().toISOString() },
    } as Job<PayoutJobData, any, string>;

    await expect(processor.process(job)).rejects.toThrow(
      "Unknown payout job type: unknown-job-type",
    );
  });

  it("should not call initiatePayout when booking status is not COMPLETED", async () => {
    const job = {
      id: "job-4",
      name: PROCESS_PAYOUT_FOR_BOOKING,
      data: { bookingId: "booking-1", timestamp: new Date().toISOString() },
    } as Job<PayoutJobData, any, string>;

    vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(
      createBooking({ id: "booking-1", status: BookingStatus.ACTIVE }),
    );

    const result = await processor.process(job);

    expect(paymentService.initiatePayout).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, reason: "INVALID_BOOKING_STATUS" });
  });

  it("should throw error when database query fails", async () => {
    const job = {
      id: "job-5",
      name: PROCESS_PAYOUT_FOR_BOOKING,
      data: { bookingId: "booking-1", timestamp: new Date().toISOString() },
    } as Job<PayoutJobData, any, string>;

    const dbError = new Error("Database connection failed");
    vi.mocked(databaseService.booking.findUnique).mockRejectedValueOnce(dbError);

    await expect(processor.process(job)).rejects.toThrow("Database connection failed");
    expect(paymentService.initiatePayout).not.toHaveBeenCalled();
  });

  it("should throw error when initiatePayout fails", async () => {
    const job = {
      id: "job-6",
      name: PROCESS_PAYOUT_FOR_BOOKING,
      data: { bookingId: "booking-1", timestamp: new Date().toISOString() },
    } as Job<PayoutJobData, any, string>;

    vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(
      createBooking({ id: "booking-1", status: BookingStatus.COMPLETED }),
    );

    const payoutError = new Error("Payout service unavailable");
    vi.mocked(paymentService.initiatePayout).mockRejectedValueOnce(payoutError);

    await expect(processor.process(job)).rejects.toThrow("Payout service unavailable");
    expect(paymentService.initiatePayout).toHaveBeenCalled();
  });
});
