import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { CLIENT_RECIPIENT_TYPE } from "../src/modules/notification/notification.const";
import {
  NotificationAudience,
  NotificationChannel,
  type NotificationJobData,
  type NotificationResult,
  NotificationType,
} from "../src/modules/notification/notification.interface";
import { NotificationProcessor } from "../src/modules/notification/notification.processor";
import { PushService } from "../src/modules/notification/push.service";
import { PushTokenService } from "../src/modules/notification/push-token.service";
import { BOOKING_STATUS_TEMPLATE_KIND } from "../src/modules/notification/template-data.interface";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Notification push delivery (e2e)", () => {
  let app: INestApplication;
  let processor: NotificationProcessor;
  let pushTokenService: PushTokenService;
  let factory: TestDataFactory;

  const sendPushNotifications = vi.fn();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(PushService)
      .useValue({ sendPushNotifications })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    processor = app.get(NotificationProcessor);
    pushTokenService = app.get(PushTokenService);
    factory = new TestDataFactory(app.get(DatabaseService), app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("delivers to a token registered after the durable job payload was built", async () => {
    const customer = await factory.createUser({
      email: uniqueEmail("late-push-token"),
      name: "Late Push Token",
    });
    const jobData: NotificationJobData = {
      id: `late-token-${customer.id}`,
      type: NotificationType.BOOKING_STATUS_CHANGE,
      audience: NotificationAudience.CUSTOMER,
      channels: [NotificationChannel.PUSH],
      bookingId: "booking-late-token",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          userId: customer.id,
        },
      },
      templateData: {
        templateKind: BOOKING_STATUS_TEMPLATE_KIND,
        id: "booking-late-token",
        bookingReference: "BR-LATE",
        customerName: customer.name,
        ownerName: "Owner",
        chauffeurName: "Chauffeur",
        chauffeurPhoneNumber: "",
        carName: "Car",
        pickupLocation: "Pickup",
        returnLocation: "Return",
        startDate: "2026-07-27",
        endDate: "2026-07-28",
        totalAmount: "10000",
        title: "Booking status updated",
        status: "confirmed",
        cancellationReason: "",
        subject: "Booking status updated",
        oldStatus: "pending",
        newStatus: "confirmed",
      },
    };

    expect(jobData.recipients[CLIENT_RECIPIENT_TYPE]).not.toHaveProperty("pushTokens");

    const token = "ExponentPushToken[registered-after-job-build]";
    await pushTokenService.registerToken(customer.id, token, "ios");
    sendPushNotifications.mockResolvedValueOnce({
      sent: 1,
      failed: 0,
      invalidTokens: [],
    });

    const job = {
      id: "late-token-job",
      data: jobData,
      progress: 0,
      attemptsMade: 0,
      opts: { attempts: 3 },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    } as unknown as Job<NotificationJobData, NotificationResult[], string>;

    await expect(processor.process(job)).resolves.toEqual([
      expect.objectContaining({
        channel: NotificationChannel.PUSH,
        success: true,
      }),
    ]);
    expect(sendPushNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: [token],
      }),
    );
  });
});
