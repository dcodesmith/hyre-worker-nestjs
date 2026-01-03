import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOKING_LEG_END_REMINDER,
  BOOKING_LEG_START_REMINDER,
  TRIP_END,
  TRIP_START,
} from "../../config/constants";
import { ReminderJobData } from "./reminder.interface";
import { ReminderProcessor } from "./reminder.processor";
import { ReminderService } from "./reminder.service";

describe("ReminderProcessor", () => {
  let processor: ReminderProcessor;
  let reminderService: ReminderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReminderProcessor,
        {
          provide: ReminderService,
          useValue: {
            sendBookingStartReminderEmails: vi.fn(),
            sendBookingEndReminderEmails: vi.fn(),
          },
        },
      ],
    }).compile();

    processor = module.get<ReminderProcessor>(ReminderProcessor);
    reminderService = module.get<ReminderService>(ReminderService);
  });

  it("should process BOOKING_LEG_START_REMINDER job and call sendBookingStartReminderEmails", async () => {
    const job = {
      id: "job-1",
      name: BOOKING_LEG_START_REMINDER,
      data: { type: TRIP_START, timestamp: new Date().toISOString() },
    } as Job<ReminderJobData, any, string>;

    vi.mocked(reminderService.sendBookingStartReminderEmails).mockResolvedValueOnce(
      "Queued 10 start reminder notifications.",
    );

    const result = await processor.process(job);

    expect(reminderService.sendBookingStartReminderEmails).toHaveBeenCalledExactlyOnceWith();
    expect(result).toEqual({
      success: true,
      result: "Queued 10 start reminder notifications.",
    });
  });

  it("should process BOOKING_LEG_END_REMINDER job and call sendBookingEndReminderEmails", async () => {
    const job = {
      id: "job-2",
      name: BOOKING_LEG_END_REMINDER,
      data: { type: TRIP_END, timestamp: new Date().toISOString() },
    } as Job<ReminderJobData, any, string>;

    vi.mocked(reminderService.sendBookingEndReminderEmails).mockResolvedValueOnce(
      "Queued 5 end reminder notifications.",
    );

    const result = await processor.process(job);

    expect(reminderService.sendBookingEndReminderEmails).toHaveBeenCalledExactlyOnceWith();
    expect(result).toEqual({
      success: true,
      result: "Queued 5 end reminder notifications.",
    });
  });

  it("should handle empty result from sendBookingStartReminderEmails", async () => {
    const job = {
      id: "job-3",
      name: BOOKING_LEG_START_REMINDER,
      data: { type: TRIP_START, timestamp: new Date().toISOString() },
    } as Job<ReminderJobData, any, string>;

    vi.mocked(reminderService.sendBookingStartReminderEmails).mockResolvedValueOnce(
      "No relevant booking legs today, so no start reminders to send.",
    );

    const result = await processor.process(job);

    expect(result).toEqual({
      success: true,
      result: "No relevant booking legs today, so no start reminders to send.",
    });
  });

  it("should handle empty result from sendBookingEndReminderEmails", async () => {
    const job = {
      id: "job-4",
      name: BOOKING_LEG_END_REMINDER,
      data: { type: TRIP_END, timestamp: new Date().toISOString() },
    } as Job<ReminderJobData, any, string>;

    vi.mocked(reminderService.sendBookingEndReminderEmails).mockResolvedValueOnce(
      "No relevant booking legs today, so no end reminders to send.",
    );

    const result = await processor.process(job);

    expect(result).toEqual({
      success: true,
      result: "No relevant booking legs today, so no end reminders to send.",
    });
  });

  it("should throw error for unknown job type", async () => {
    const job = {
      id: "job-5",
      name: "unknown-job-type",
      data: { type: TRIP_START, timestamp: new Date().toISOString() },
    } as Job<ReminderJobData, any, string>;

    await expect(processor.process(job)).rejects.toThrow(
      "Unknown reminder job type: unknown-job-type",
    );
  });

  it("should throw error when sendBookingStartReminderEmails fails", async () => {
    const job = {
      id: "job-6",
      name: BOOKING_LEG_START_REMINDER,
      data: { type: TRIP_START, timestamp: new Date().toISOString() },
    } as Job<ReminderJobData, any, string>;

    const serviceError = new Error("Notification service unavailable");
    vi.mocked(reminderService.sendBookingStartReminderEmails).mockRejectedValueOnce(serviceError);

    await expect(processor.process(job)).rejects.toThrow("Notification service unavailable");
    expect(reminderService.sendBookingStartReminderEmails).toHaveBeenCalled();
  });

  it("should throw error when sendBookingEndReminderEmails fails", async () => {
    const job = {
      id: "job-7",
      name: BOOKING_LEG_END_REMINDER,
      data: { type: TRIP_END, timestamp: new Date().toISOString() },
    } as Job<ReminderJobData, any, string>;

    const serviceError = new Error("Database connection failed");
    vi.mocked(reminderService.sendBookingEndReminderEmails).mockRejectedValueOnce(serviceError);

    await expect(processor.process(job)).rejects.toThrow("Database connection failed");
    expect(reminderService.sendBookingEndReminderEmails).toHaveBeenCalled();
  });
});
