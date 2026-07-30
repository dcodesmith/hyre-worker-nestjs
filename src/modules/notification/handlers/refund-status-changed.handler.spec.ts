import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationOutboxEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationService } from "../notification.service";
import { RefundStatusChangedHandler } from "./refund-status-changed.handler";

describe("RefundStatusChangedHandler", () => {
  let handler: RefundStatusChangedHandler;
  let notificationService: NotificationService;

  const input = {
    refundId: "refund-123",
    paymentId: "payment-123",
    bookingId: "booking-123",
    bookingReference: "BR-123",
    status: "REFUNDED" as const,
    amount: 15000,
    customer: {
      userId: "customer-123",
      name: "Customer",
      email: "customer@example.com",
      phoneNumber: "+2348012345678",
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundStatusChangedHandler,
        {
          provide: NotificationService,
          useValue: {
            buildRefundStatusChangedJobData: vi.fn(),
          },
        },
      ],
    }).compile();

    handler = module.get(RefundStatusChangedHandler);
    notificationService = module.get(NotificationService);
  });

  it("builds one deterministic booking-lifecycle outbox event", async () => {
    const jobData = { id: "job-123" };
    vi.mocked(notificationService.buildRefundStatusChangedJobData).mockReturnValueOnce(
      jobData as never,
    );

    await expect(handler.buildEvents(input)).resolves.toEqual([
      {
        jobData,
        dedupeKey: "refund-status:refund-123:REFUNDED",
        userId: null,
        subtype: "REFUND_REFUNDED",
      },
    ]);
    expect(handler.eventType).toBe(NotificationOutboxEventType.BOOKING_LIFECYCLE);
  });

  it("does not write an outbox event when no delivery channel is available", async () => {
    vi.mocked(notificationService.buildRefundStatusChangedJobData).mockReturnValueOnce(null);

    await expect(handler.buildEvents(input)).resolves.toEqual([]);
  });
});
