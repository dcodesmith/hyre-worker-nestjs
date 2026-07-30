import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationOutboxEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationService } from "../notification.service";
import { PayoutStatusChangedHandler } from "./payout-status-changed.handler";

describe("PayoutStatusChangedHandler", () => {
  let handler: PayoutStatusChangedHandler;
  let notificationService: NotificationService;

  const input = {
    payoutTransactionId: "payout-123",
    bookingId: "booking-123",
    bookingReference: "BR-123",
    status: "PAID_OUT" as const,
    amount: 15000,
    fleetOwner: {
      userId: "owner-123",
      name: "Fleet Owner",
      email: "owner@example.com",
      phoneNumber: "+2348012345678",
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutStatusChangedHandler,
        {
          provide: NotificationService,
          useValue: {
            buildPayoutStatusChangedJobData: vi.fn(),
          },
        },
      ],
    }).compile();

    handler = module.get(PayoutStatusChangedHandler);
    notificationService = module.get(NotificationService);
  });

  it("builds one deterministic booking-lifecycle outbox event", async () => {
    const jobData = { id: "job-123" };
    vi.mocked(notificationService.buildPayoutStatusChangedJobData).mockReturnValueOnce(
      jobData as never,
    );

    await expect(handler.buildEvents(input)).resolves.toEqual([
      {
        jobData,
        dedupeKey: "payout-status:payout-123:PAID_OUT",
        userId: null,
        subtype: "PAYOUT_PAID_OUT",
      },
    ]);
    expect(handler.eventType).toBe(NotificationOutboxEventType.BOOKING_LIFECYCLE);
  });

  it("does not write an outbox event when no delivery channel is available", async () => {
    vi.mocked(notificationService.buildPayoutStatusChangedJobData).mockReturnValueOnce(null);

    await expect(handler.buildEvents(input)).resolves.toEqual([]);
  });
});
