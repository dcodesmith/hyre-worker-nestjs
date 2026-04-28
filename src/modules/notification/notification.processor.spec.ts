import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as emailTemplates from "../../templates/emails";
import { EmailService } from "../email/email.service";
import { CLIENT_RECIPIENT_TYPE, FLEET_OWNER_RECIPIENT_TYPE } from "./notification.const";
import {
  NotificationChannel,
  NotificationJobData,
  NotificationResult,
  NotificationType,
} from "./notification.interface";
import { NotificationProcessor } from "./notification.processor";
import {
  BOOKING_REMINDER_TEMPLATE_KIND,
  BOOKING_STATUS_TEMPLATE_KIND,
  REVIEW_RECEIVED_TEMPLATE_KIND,
} from "./template-data.interface";
import { WhatsAppService } from "./whatsapp.service";

describe("NotificationProcessor", () => {
  let processor: NotificationProcessor;
  let emailService: EmailService;
  let whatsAppService: WhatsAppService;

  const createJob = (
    id: string,
    data: NotificationJobData,
    progress: object | number = 0,
  ): Job<NotificationJobData, NotificationResult[], string> =>
    ({
      id,
      name: "send-notification",
      data,
      progress,
      attemptsMade: 0,
      opts: { attempts: 3 },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    }) as unknown as Job<NotificationJobData, NotificationResult[], string>;

  beforeEach(async () => {
    // Spy on the template functions
    vi.spyOn(emailTemplates, "renderBookingStatusUpdateEmail").mockResolvedValue(
      "<html>Status email</html>",
    );

    vi.spyOn(emailTemplates, "renderBookingReminderEmail").mockResolvedValue(
      "<html>Reminder email</html>",
    );
    vi.spyOn(emailTemplates, "renderReviewReceivedEmailForOwner").mockResolvedValue(
      "<html>Owner review email</html>",
    );
    vi.spyOn(emailTemplates, "renderReviewReceivedEmailForChauffeur").mockResolvedValue(
      "<html>Chauffeur review email</html>",
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationProcessor,
        {
          provide: EmailService,
          useValue: {
            sendEmail: vi.fn(),
          },
        },
        {
          provide: WhatsAppService,
          useValue: {
            sendMessage: vi.fn(),
          },
        },
      ],
    }).compile();

    processor = module.get<NotificationProcessor>(NotificationProcessor);
    emailService = module.get<EmailService>(EmailService);
    whatsAppService = module.get<WhatsAppService>(WhatsAppService);
  });

  it("should process notification job with EMAIL channel successfully", async () => {
    const job = createJob("job-1", {
      id: "notification-1",
      type: NotificationType.BOOKING_STATUS_CHANGE,
      channels: [NotificationChannel.EMAIL],
      bookingId: "booking-123",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          email: "client@example.com",
        },
      },
      templateData: {
        templateKind: BOOKING_STATUS_TEMPLATE_KIND,
        id: "booking-123",
        bookingReference: "BR-123",
        customerName: "John Doe",
        ownerName: "Owner Name",
        chauffeurName: "Chauffeur Name",
        chauffeurPhoneNumber: "1234567890",
        carName: "Car Name",
        pickupLocation: "Pickup Location",
        returnLocation: "Return Location",
        startDate: "2024-01-01",
        endDate: "2024-01-02",
        totalAmount: "10000",
        title: "Booking Title",
        status: "ACTIVE",
        cancellationReason: "",
        subject: "Booking Status Update",
        oldStatus: "CONFIRMED",
        newStatus: "ACTIVE",
      },
    });

    vi.mocked(emailService.sendEmail).mockResolvedValueOnce({
      data: { id: "email-msg-1" },
      error: null,
      headers: {},
    });

    const results = await processor.process(job);

    expect(emailService.sendEmail).toHaveBeenCalledWith({
      to: "client@example.com",
      subject: "Booking Status Update",
      html: "<html>Status email</html>",
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      channel: NotificationChannel.EMAIL,
      success: true,
      messageId: "email-sent",
      perRecipientResults: [
        {
          recipient: CLIENT_RECIPIENT_TYPE,
          email: "client@example.com",
          success: true,
          messageId: "email-msg-1",
        },
      ],
    });
  });

  it("should process notification job with WHATSAPP channel successfully", async () => {
    const job = createJob("job-2", {
      id: "notification-2",
      type: NotificationType.BOOKING_REMINDER_START,
      channels: [NotificationChannel.WHATSAPP],
      bookingId: "booking-456",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          phoneNumber: "+1234567890",
        },
      },
      templateData: {
        templateKind: BOOKING_REMINDER_TEMPLATE_KIND,
        bookingLegId: "leg-1",
        bookingId: "booking-456",
        bookingReference: "BR-456",
        customerName: "John Doe",
        chauffeurName: "Chauffeur Name",
        customerPhone: "+1234567890",
        legDate: "2024-01-01",
        legStartTime: "10:00",
        legEndTime: "18:00",
        carName: "Car Name",
        pickupLocation: "Pickup Location",
        returnLocation: "Return Location",
        subject: "Booking Reminder",
        recipientType: CLIENT_RECIPIENT_TYPE,
      },
    });

    vi.mocked(whatsAppService.sendMessage).mockResolvedValueOnce(undefined);

    const results = await processor.process(job);

    expect(whatsAppService.sendMessage).toHaveBeenCalledWith({
      to: "+1234567890",
      templateKey: expect.any(String),
      variables: expect.objectContaining({
        "1": "John Doe",
        "2": "Car Name",
        "3": "10:00",
        "4": "18:00",
        "5": "Pickup Location",
        "6": "Return Location",
        "7": "Chauffeur Name",
      }),
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      channel: NotificationChannel.WHATSAPP,
      success: true,
      messageId: "whatsapp-sent",
    });
  });

  it("should process notification job with both EMAIL and WHATSAPP channels", async () => {
    const job = createJob("job-3", {
      id: "notification-3",
      type: NotificationType.BOOKING_REMINDER_END,
      channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
      bookingId: "booking-789",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          email: "client@example.com",
          phoneNumber: "+1234567890",
        },
      },
      templateData: {
        templateKind: BOOKING_REMINDER_TEMPLATE_KIND,
        bookingLegId: "leg-1",
        bookingId: "booking-789",
        bookingReference: "BR-789",
        customerName: "John Doe",
        chauffeurName: "Chauffeur Name",
        customerPhone: "+1234567890",
        legDate: "2024-01-01",
        legStartTime: "10:00",
        legEndTime: "18:00",
        carName: "Car Name",
        pickupLocation: "Pickup Location",
        returnLocation: "Return Location",
        subject: "Booking End Reminder",
        recipientType: CLIENT_RECIPIENT_TYPE,
      },
    });

    vi.mocked(emailService.sendEmail).mockResolvedValueOnce({
      data: { id: "email-msg-2" },
      error: null,
      headers: {},
    });
    vi.mocked(whatsAppService.sendMessage).mockResolvedValueOnce(undefined);

    const results = await processor.process(job);

    expect(emailService.sendEmail).toHaveBeenCalledWith({
      to: "client@example.com",
      subject: "Booking End Reminder",
      html: "<html>Reminder email</html>",
    });
    expect(whatsAppService.sendMessage).toHaveBeenCalledWith({
      to: "+1234567890",
      templateKey: expect.any(String),
      variables: expect.objectContaining({
        "1": "John Doe",
        "2": "Car Name",
      }),
    });
    expect(results).toHaveLength(2);
    expect(results[0]?.channel).toBe(NotificationChannel.EMAIL);
    expect(results[1]?.channel).toBe(NotificationChannel.WHATSAPP);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it("should return empty results when no recipients are provided", async () => {
    const job = createJob("job-4", {
      id: "notification-4",
      type: NotificationType.BOOKING_STATUS_CHANGE,
      channels: [NotificationChannel.EMAIL],
      bookingId: "booking-999",
      recipients: {},
      templateData: {
        templateKind: BOOKING_STATUS_TEMPLATE_KIND,
        id: "booking-999",
        bookingReference: "BR-999",
        customerName: "John Doe",
        ownerName: "Owner Name",
        chauffeurName: "Chauffeur Name",
        chauffeurPhoneNumber: "1234567890",
        carName: "Car Name",
        pickupLocation: "Pickup Location",
        returnLocation: "Return Location",
        startDate: "2024-01-01",
        endDate: "2024-01-02",
        totalAmount: "10000",
        title: "Booking Title",
        status: "ACTIVE",
        cancellationReason: "",
        subject: "Booking Status Update",
        oldStatus: "CONFIRMED",
        newStatus: "ACTIVE",
      },
    });

    const results = await processor.process(job);

    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
  });

  it("should handle email service errors gracefully", async () => {
    const job = createJob("job-5", {
      id: "notification-5",
      type: NotificationType.BOOKING_STATUS_CHANGE,
      channels: [NotificationChannel.EMAIL],
      bookingId: "booking-111",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          email: "client@example.com",
        },
      },
      templateData: {
        templateKind: BOOKING_STATUS_TEMPLATE_KIND,
        id: "booking-111",
        bookingReference: "BR-111",
        customerName: "John Doe",
        ownerName: "Owner Name",
        chauffeurName: "Chauffeur Name",
        chauffeurPhoneNumber: "1234567890",
        carName: "Car Name",
        pickupLocation: "Pickup Location",
        returnLocation: "Return Location",
        startDate: "2024-01-01",
        endDate: "2024-01-02",
        totalAmount: "10000",
        title: "Booking Title",
        status: "ACTIVE",
        cancellationReason: "",
        subject: "Booking Status Update",
        oldStatus: "CONFIRMED",
        newStatus: "ACTIVE",
      },
    });

    const emailError = new Error("Email service unavailable");
    vi.mocked(emailService.sendEmail).mockRejectedValueOnce(emailError);

    await expect(processor.process(job)).rejects.toThrow(
      "Notification channel delivery failed for notification notification-5: email",
    );
  });

  it("should handle whatsapp service errors gracefully", async () => {
    const job = createJob("job-6", {
      id: "notification-6",
      type: NotificationType.BOOKING_REMINDER_START,
      channels: [NotificationChannel.WHATSAPP],
      bookingId: "booking-222",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          phoneNumber: "+1234567890",
        },
      },
      templateData: {
        templateKind: BOOKING_REMINDER_TEMPLATE_KIND,
        bookingLegId: "leg-1",
        bookingId: "booking-222",
        bookingReference: "BR-222",
        customerName: "John Doe",
        chauffeurName: "Chauffeur Name",
        customerPhone: "+1234567890",
        legDate: "2024-01-01",
        legStartTime: "10:00",
        legEndTime: "18:00",
        carName: "Car Name",
        pickupLocation: "Pickup Location",
        returnLocation: "Return Location",
        subject: "Booking Reminder",
        recipientType: CLIENT_RECIPIENT_TYPE,
      },
    });

    const whatsappError = new Error("WhatsApp service unavailable");
    vi.mocked(whatsAppService.sendMessage).mockRejectedValueOnce(whatsappError);

    await expect(processor.process(job)).rejects.toThrow(
      "Notification channel delivery failed for notification notification-6: whatsapp",
    );
  });

  it("should normalize serialized reviewDate before rendering review email", async () => {
    const reviewDateIso = "2026-02-17T00:00:00.000Z";
    const job = createJob("job-8", {
      id: "notification-8",
      type: NotificationType.REVIEW_RECEIVED,
      channels: [NotificationChannel.EMAIL],
      bookingId: "booking-444",
      recipients: {
        [FLEET_OWNER_RECIPIENT_TYPE]: {
          email: "owner@example.com",
        },
      },
      templateData: {
        templateKind: REVIEW_RECEIVED_TEMPLATE_KIND,
        ownerName: "Fleet Owner",
        chauffeurName: "Driver Name",
        customerName: "John Doe",
        bookingReference: "BK-12345678",
        carName: "Toyota Camry",
        overallRating: 5,
        carRating: 5,
        chauffeurRating: 5,
        serviceRating: 5,
        comment: "Great service",
        reviewDate: reviewDateIso,
        subject: "New 5-star review received for Toyota Camry",
      },
    });

    vi.mocked(emailService.sendEmail).mockResolvedValueOnce({
      data: { id: "email-msg-4" },
      error: null,
      headers: {},
    });

    const results = await processor.process(job);
    const ownerRenderCall = vi.mocked(emailTemplates.renderReviewReceivedEmailForOwner).mock
      .calls[0];
    const renderedTemplateData = ownerRenderCall?.[1];

    expect(emailTemplates.renderReviewReceivedEmailForOwner).toHaveBeenCalledTimes(1);
    expect(renderedTemplateData?.reviewDate).toBeInstanceOf(Date);
    expect((renderedTemplateData?.reviewDate as Date).toISOString()).toBe(reviewDateIso);
    expect(emailService.sendEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      subject: "New 5-star review received for Toyota Camry",
      html: "<html>Owner review email</html>",
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      channel: NotificationChannel.EMAIL,
      success: true,
      messageId: "email-sent",
      perRecipientResults: [
        {
          recipient: FLEET_OWNER_RECIPIENT_TYPE,
          email: "owner@example.com",
          success: true,
          messageId: "email-msg-4",
        },
      ],
    });
  });

  it("should skip already succeeded channels on retry and continue failed channel", async () => {
    const baseData: NotificationJobData = {
      id: "notification-10",
      type: NotificationType.BOOKING_REMINDER_END,
      channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
      bookingId: "booking-777",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          email: "client@example.com",
          phoneNumber: "+1234567890",
        },
      },
      templateData: {
        templateKind: BOOKING_REMINDER_TEMPLATE_KIND,
        bookingLegId: "leg-1",
        bookingId: "booking-777",
        bookingReference: "BR-777",
        customerName: "John Doe",
        chauffeurName: "Chauffeur Name",
        customerPhone: "+1234567890",
        legDate: "2024-01-01",
        legStartTime: "10:00",
        legEndTime: "18:00",
        carName: "Car Name",
        pickupLocation: "Pickup Location",
        returnLocation: "Return Location",
        subject: "Booking End Reminder",
        recipientType: CLIENT_RECIPIENT_TYPE,
      },
    };

    const firstAttempt = createJob("job-10-attempt-1", baseData);
    vi.mocked(emailService.sendEmail).mockResolvedValueOnce({
      data: { id: "email-msg-10" },
      error: null,
      headers: {},
    });
    vi.mocked(whatsAppService.sendMessage).mockRejectedValueOnce(new Error("Temporary outage"));

    await expect(processor.process(firstAttempt)).rejects.toThrow(
      "Notification channel delivery failed for notification notification-10: whatsapp",
    );
    expect(firstAttempt.updateProgress).toHaveBeenCalledWith({
      succeededChannels: [NotificationChannel.EMAIL],
    });

    const secondAttempt = createJob("job-10-attempt-2", baseData, {
      succeededChannels: [NotificationChannel.EMAIL],
    });
    vi.mocked(whatsAppService.sendMessage).mockResolvedValueOnce(undefined);

    const secondResults = await processor.process(secondAttempt);

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(whatsAppService.sendMessage).toHaveBeenCalledTimes(2);
    expect(secondResults).toEqual([
      {
        channel: NotificationChannel.WHATSAPP,
        success: true,
        messageId: "whatsapp-sent",
      },
    ]);
  });
});
