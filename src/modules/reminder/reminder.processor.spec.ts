import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { REMINDERS_QUEUE, TRIP_START } from "../../config/constants";
import { captureTerminalJobFailure } from "../infra/queue-infra/bullmq-telemetry";

const { captureTerminalJobFailureMock } = vi.hoisted(() => ({
  captureTerminalJobFailureMock: vi.fn(),
}));

vi.mock("../infra/queue-infra/bullmq-telemetry", () => ({
  captureTerminalJobFailure: captureTerminalJobFailureMock,
}));

import { ReminderJobData } from "./reminder.interface";
import { ReminderProcessor } from "./reminder.processor";
import { ReminderService } from "./reminder.service";

describe("ReminderProcessor", () => {
  let processor: ReminderProcessor;
  let logger: PinoLogger;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReminderProcessor,
        {
          provide: ReminderService,
          useValue: {
            sendBookingStartReminders: vi.fn(),
            sendBookingEndReminders: vi.fn(),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    processor = module.get<ReminderProcessor>(ReminderProcessor);
    logger = module.get<PinoLogger>(PinoLogger);
  });

  it("should throw error for unknown job type", async () => {
    const job = {
      id: "job-5",
      name: "unknown-job-type",
      data: { type: TRIP_START, timestamp: new Date().toISOString() },
    } as Job<ReminderJobData, { success: boolean; result?: string }, string>;

    await expect(processor.process(job)).rejects.toThrow(
      "Unknown reminder job type: unknown-job-type",
    );
  });

  it("captures a missing-job worker failure without dereferencing the job", () => {
    vi.clearAllMocks();
    const error = new Error("job lost");

    expect(() => processor.onFailed(undefined, error)).not.toThrow();

    expect(captureTerminalJobFailure).toHaveBeenCalledExactlyOnceWith(
      undefined,
      error,
      REMINDERS_QUEUE,
    );
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      { err: error },
      "Reminder job failed without context",
    );
  });
});
