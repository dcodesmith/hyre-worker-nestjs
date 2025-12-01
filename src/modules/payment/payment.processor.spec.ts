import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    const job: any = {
      name: PROCESS_PAYOUT_FOR_BOOKING,
      data: { bookingId: "booking-1", timestamp: new Date().toISOString() } as PayoutJobData,
    };

    (
      databaseService.booking.findUnique as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      id: "booking-1",
      status: BookingStatus.COMPLETED,
    });

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
    const job: any = {
      name: PROCESS_PAYOUT_FOR_BOOKING,
      data: { bookingId: "missing-booking", timestamp: new Date().toISOString() } as PayoutJobData,
    };

    (
      databaseService.booking.findUnique as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);

    const result = await processor.process(job);

    expect(paymentService.initiatePayout).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, reason: "BOOKING_NOT_FOUND" });
  });
});
