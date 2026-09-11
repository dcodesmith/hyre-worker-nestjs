import { Test, type TestingModule } from "@nestjs/testing";
import { DomainOutboxEventType, DomainOutboxStatus } from "@prisma/client";
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DOMAIN_OUTBOX_QUEUE } from "../../config/constants";
import { captureException } from "../../sentry";
import {
  PayoutBookingNotCompletedException,
  PayoutBookingNotFoundException,
} from "../payment/payment.error";

const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

vi.mock("../../sentry", () => ({
  captureException: captureExceptionMock,
}));

import { PaymentService } from "../payment/payment.service";
import { ReferralProcessingService } from "../referral/referral-processing.service";
import type { DomainOutboxJobData } from "./domain-outbox.interface";
import { DomainOutboxProcessor } from "./domain-outbox.processor";
import { DOMAIN_OUTBOX_MAX_ATTEMPTS, DomainOutboxService } from "./domain-outbox.service";

describe("DomainOutboxProcessor", () => {
  let processor: DomainOutboxProcessor;
  const domainOutboxService = {
    resolveExecutableEvent: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
  };
  const referralProcessingService = {
    processReferralCompletionForBooking: vi.fn(),
  };
  const paymentService = {
    processPayoutForBooking: vi.fn(),
  };

  const createJob = (
    eventType: DomainOutboxEventType = DomainOutboxEventType.REFERRAL_COMPLETION,
    options: { attemptsMade?: number; dispatchAttempt?: number } = {},
  ) =>
    ({
      id: "domain-outbox-outbox-1-1",
      name: eventType,
      data: {
        outboxEventId: "outbox-1",
        eventType,
        aggregateId: "booking-1",
        dispatchAttempt: options.dispatchAttempt ?? 1,
      },
      attemptsMade: options.attemptsMade ?? 0,
      opts: { attempts: 3 },
    }) as Job<DomainOutboxJobData>;

  beforeEach(async () => {
    vi.clearAllMocks();
    domainOutboxService.resolveExecutableEvent.mockImplementation(
      async (data: DomainOutboxJobData) => ({
        id: data.outboxEventId,
        eventType: data.eventType,
        aggregateId: data.aggregateId,
        status: DomainOutboxStatus.DISPATCHED,
        attempts: data.dispatchAttempt,
        updatedAt: new Date(),
      }),
    );
    domainOutboxService.markCompleted.mockResolvedValue(undefined);
    domainOutboxService.markFailed.mockResolvedValue(undefined);
    referralProcessingService.processReferralCompletionForBooking.mockResolvedValue(undefined);
    paymentService.processPayoutForBooking.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DomainOutboxProcessor,
        { provide: DomainOutboxService, useValue: domainOutboxService },
        { provide: ReferralProcessingService, useValue: referralProcessingService },
        { provide: PaymentService, useValue: paymentService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    processor = module.get(DomainOutboxProcessor);
  });

  it("marks referral execution completed only after the handler succeeds", async () => {
    await processor.process(createJob());

    expect(
      referralProcessingService.processReferralCompletionForBooking,
    ).toHaveBeenCalledExactlyOnceWith("booking-1");
    expect(domainOutboxService.markCompleted).toHaveBeenCalledExactlyOnceWith("outbox-1", 1);
  });

  it("routes payout execution through the payment service", async () => {
    await processor.process(createJob(DomainOutboxEventType.PAYOUT_PROCESSING));

    expect(paymentService.processPayoutForBooking).toHaveBeenCalledExactlyOnceWith("booking-1");
    expect(domainOutboxService.markCompleted).toHaveBeenCalledExactlyOnceWith("outbox-1", 1);
  });

  it("skips jobs that no longer match a dispatched outbox event", async () => {
    domainOutboxService.resolveExecutableEvent.mockResolvedValueOnce(null);

    await processor.process(createJob(DomainOutboxEventType.PAYOUT_PROCESSING));

    expect(paymentService.processPayoutForBooking).not.toHaveBeenCalled();
    expect(domainOutboxService.markCompleted).not.toHaveBeenCalled();
    expect(domainOutboxService.markFailed).not.toHaveBeenCalled();
  });

  it("leaves intermediate failures dispatched for BullMQ retry", async () => {
    referralProcessingService.processReferralCompletionForBooking.mockRejectedValueOnce(
      new Error("temporary failure"),
    );

    await expect(processor.process(createJob())).rejects.toThrow("temporary failure");

    expect(domainOutboxService.markFailed).not.toHaveBeenCalled();
    expect(domainOutboxService.markCompleted).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each([1, 7])(
    "persists a BullMQ-final failure on durable attempt %s without capturing",
    async (dispatchAttempt) => {
      const error = new Error("persistent failure");
      referralProcessingService.processReferralCompletionForBooking.mockRejectedValueOnce(error);

      await expect(
        processor.process(
          createJob(DomainOutboxEventType.REFERRAL_COMPLETION, {
            attemptsMade: 2,
            dispatchAttempt,
          }),
        ),
      ).rejects.toBe(error);

      expect(domainOutboxService.markFailed).toHaveBeenCalledExactlyOnceWith(
        "outbox-1",
        dispatchAttempt,
        error,
      );
      expect(captureException).not.toHaveBeenCalled();
    },
  );

  it("captures a durable attempt-8 failure before persisting markFailed", async () => {
    const error = new Error("persistent failure");
    referralProcessingService.processReferralCompletionForBooking.mockRejectedValueOnce(error);

    await expect(
      processor.process(
        createJob(DomainOutboxEventType.REFERRAL_COMPLETION, {
          attemptsMade: 2,
          dispatchAttempt: DOMAIN_OUTBOX_MAX_ATTEMPTS,
        }),
      ),
    ).rejects.toBe(error);

    expect(captureException).toHaveBeenCalledExactlyOnceWith(error, {
      message: "Domain outbox event failed permanently",
      tags: {
        "error.source": "bullmq",
        "job.name": DomainOutboxEventType.REFERRAL_COMPLETION,
        "queue.name": DOMAIN_OUTBOX_QUEUE,
      },
    });
    expect(domainOutboxService.markFailed).toHaveBeenCalledExactlyOnceWith(
      "outbox-1",
      DOMAIN_OUTBOX_MAX_ATTEMPTS,
      error,
    );
    expect(captureExceptionMock.mock.invocationCallOrder[0]).toBeLessThan(
      domainOutboxService.markFailed.mock.invocationCallOrder[0],
    );
  });

  it.each([
    new PayoutBookingNotFoundException("booking-1"),
    new PayoutBookingNotCompletedException("booking-1"),
  ])("dead-letters terminal payout invariant failures", async (error) => {
    paymentService.processPayoutForBooking.mockRejectedValueOnce(error);

    await processor.process(createJob(DomainOutboxEventType.PAYOUT_PROCESSING));

    expect(domainOutboxService.markFailed).toHaveBeenCalledExactlyOnceWith(
      "outbox-1",
      1,
      error,
      true,
    );
    expect(domainOutboxService.markCompleted).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(error, {
      message: "Domain outbox event failed permanently",
      tags: {
        "error.source": "bullmq",
        "job.name": DomainOutboxEventType.PAYOUT_PROCESSING,
        "queue.name": DOMAIN_OUTBOX_QUEUE,
      },
    });
  });

  it("retries when persisting business completion fails", async () => {
    domainOutboxService.markCompleted.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(processor.process(createJob())).rejects.toThrow("database unavailable");

    expect(domainOutboxService.markFailed).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("captures a durable attempt-8 markCompleted failure before markFailed", async () => {
    const error = new Error("database unavailable");
    domainOutboxService.markCompleted.mockRejectedValueOnce(error);

    await expect(
      processor.process(
        createJob(DomainOutboxEventType.REFERRAL_COMPLETION, {
          attemptsMade: 2,
          dispatchAttempt: DOMAIN_OUTBOX_MAX_ATTEMPTS,
        }),
      ),
    ).rejects.toBe(error);

    expect(
      referralProcessingService.processReferralCompletionForBooking,
    ).toHaveBeenCalledExactlyOnceWith("booking-1");
    expect(captureException).toHaveBeenCalledExactlyOnceWith(error, {
      message: "Domain outbox event failed permanently",
      tags: {
        "error.source": "bullmq",
        "job.name": DomainOutboxEventType.REFERRAL_COMPLETION,
        "queue.name": DOMAIN_OUTBOX_QUEUE,
      },
    });
    expect(domainOutboxService.markFailed).toHaveBeenCalledExactlyOnceWith(
      "outbox-1",
      DOMAIN_OUTBOX_MAX_ATTEMPTS,
      error,
    );
    expect(captureExceptionMock.mock.invocationCallOrder[0]).toBeLessThan(
      domainOutboxService.markFailed.mock.invocationCallOrder[0],
    );
  });

  it("rethrows the original error when terminal markFailed persistence also fails", async () => {
    const error = new Error("database unavailable");
    domainOutboxService.markCompleted.mockRejectedValueOnce(error);
    domainOutboxService.markFailed.mockRejectedValueOnce(new Error("persist failed"));

    await expect(
      processor.process(
        createJob(DomainOutboxEventType.REFERRAL_COMPLETION, {
          attemptsMade: 2,
          dispatchAttempt: DOMAIN_OUTBOX_MAX_ATTEMPTS,
        }),
      ),
    ).rejects.toBe(error);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(domainOutboxService.markFailed).toHaveBeenCalledTimes(1);
  });
});
