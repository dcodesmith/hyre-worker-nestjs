import { Test, type TestingModule } from "@nestjs/testing";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DomainOutboxScheduler } from "./domain-outbox.scheduler";
import { DomainOutboxService } from "./domain-outbox.service";

describe("DomainOutboxScheduler", () => {
  let scheduler: DomainOutboxScheduler;
  let logger: PinoLogger;
  const domainOutboxService = {
    processPendingEvents: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    domainOutboxService.processPendingEvents.mockResolvedValue(0);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DomainOutboxScheduler,
        { provide: DomainOutboxService, useValue: domainOutboxService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    scheduler = module.get(DomainOutboxScheduler);
    logger = module.get(PinoLogger);
  });

  it("processes one bounded batch and logs progress", async () => {
    domainOutboxService.processPendingEvents.mockResolvedValueOnce(2);

    await scheduler.processDomainOutbox();

    expect(domainOutboxService.processPendingEvents).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      { processedCount: 2 },
      "Processed pending domain outbox events",
    );
  });

  it("does not overlap scheduler runs", async () => {
    let release: ((value: number) => void) | undefined;
    domainOutboxService.processPendingEvents.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );

    const firstRun = scheduler.processDomainOutbox();
    await scheduler.processDomainOutbox();
    release?.(0);
    await firstRun;

    expect(domainOutboxService.processPendingEvents).toHaveBeenCalledOnce();
  });

  it("logs failures and releases the in-flight guard", async () => {
    domainOutboxService.processPendingEvents
      .mockRejectedValueOnce(new Error("Database unavailable"))
      .mockResolvedValueOnce(0);

    await scheduler.processDomainOutbox();
    await scheduler.processDomainOutbox();

    expect(domainOutboxService.processPendingEvents).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      { error: "Database unavailable" },
      "Failed to process domain outbox events",
    );
  });
});
