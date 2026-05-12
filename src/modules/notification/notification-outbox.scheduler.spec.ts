import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { NotificationOutboxScheduler } from "./notification-outbox.scheduler";
import { NotificationOutboxService } from "./notification-outbox.service";

describe("NotificationOutboxScheduler", () => {
  let scheduler: NotificationOutboxScheduler;
  let outboxService: { processPendingEvents: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    outboxService = { processPendingEvents: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationOutboxScheduler,
        { provide: NotificationOutboxService, useValue: outboxService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    scheduler = module.get(NotificationOutboxScheduler);
  });

  it("returns immediately on an empty tick (no re-entry)", async () => {
    outboxService.processPendingEvents.mockResolvedValueOnce(0);

    await scheduler.processNotificationOutbox();

    expect(outboxService.processPendingEvents).toHaveBeenCalledTimes(1);
  });

  it("re-ticks while events keep arriving, up to maxConsecutiveTicks", async () => {
    // 5 non-empty ticks then bound is hit — should not call a 6th time.
    outboxService.processPendingEvents
      .mockResolvedValueOnce(25)
      .mockResolvedValueOnce(25)
      .mockResolvedValueOnce(25)
      .mockResolvedValueOnce(25)
      .mockResolvedValueOnce(25)
      .mockResolvedValue(25);

    await scheduler.processNotificationOutbox();

    expect(outboxService.processPendingEvents).toHaveBeenCalledTimes(5);
  });

  it("stops as soon as a tick returns 0 even mid-loop", async () => {
    outboxService.processPendingEvents
      .mockResolvedValueOnce(25)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(0)
      .mockResolvedValue(99);

    await scheduler.processNotificationOutbox();

    expect(outboxService.processPendingEvents).toHaveBeenCalledTimes(3);
  });

  it("skips overlapping cron firings while a previous tick is still draining", async () => {
    let resolveFirst: (value: number) => void = () => {};
    outboxService.processPendingEvents.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const inflight = scheduler.processNotificationOutbox();
    // Second firing arrives while the first is still pending — must no-op.
    await scheduler.processNotificationOutbox();
    expect(outboxService.processPendingEvents).toHaveBeenCalledTimes(1);

    // Resolve the first call with 0 so the loop exits cleanly.
    resolveFirst(0);
    await inflight;
  });

  it("releases the in-flight guard after errors", async () => {
    outboxService.processPendingEvents
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(0);

    await scheduler.processNotificationOutbox();
    await scheduler.processNotificationOutbox();

    expect(outboxService.processPendingEvents).toHaveBeenCalledTimes(2);
  });
});
