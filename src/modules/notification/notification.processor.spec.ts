import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as emailTemplates from "../../templates/emails";
import { EmailService } from "./email.service";
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
    const job = {
      id: "job-1",
      name: "send-notification",
      data: {
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
      },
    } as Job<NotificationJobData, NotificationResult[], string>;

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
    const job = {
      id: "job-2",
      name: "send-notification",
      data: {
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
      },
    } as Job<NotificationJobData, NotificationResult[], string>;

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
    const job = {
      id: "job-3",
      name: "send-notification",
      data: {
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
      },
    } as Job<NotificationJobData, NotificationResult[], string>;

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
    const job = {
      id: "job-4",
      name: "send-notification",
      data: {
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
      },
    } as Job<NotificationJobData, NotificationResult[], string>;

    const results = await processor.process(job);

    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
  });

  it("should handle email service errors gracefully", async () => {
    const job = {
      id: "job-5",
      name: "send-notification",
      data: {
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
      },
    } as Job<NotificationJobData, NotificationResult[], string>;

    const emailError = new Error("Email service unavailable");
    vi.mocked(emailService.sendEmail).mockRejectedValueOnce(emailError);

    const results = await processor.process(job);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      channel: NotificationChannel.EMAIL,
      success: false,
      error: "One or more email recipients failed",
      perRecipientResults: [
        {
          recipient: CLIENT_RECIPIENT_TYPE,
          email: "client@example.com",
          success: false,
          error: "Email service unavailable",
        },
      ],
    });
  });

  it("should handle whatsapp service errors gracefully", async () => {
    const job = {
      id: "job-6",
      name: "send-notification",
      data: {
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
      },
    } as Job<NotificationJobData, NotificationResult[], string>;

    const whatsappError = new Error("WhatsApp service unavailable");
    vi.mocked(whatsAppService.sendMessage).mockRejectedValueOnce(whatsappError);

    const results = await processor.process(job);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      channel: NotificationChannel.WHATSAPP,
      success: false,
      error: "WhatsApp service unavailable",
    });
  });

  it("should process multiple channels and handle partial failures", async () => {
    const job = {
      id: "job-7",
      name: "send-notification",
      data: {
        id: "notification-7",
        type: NotificationType.BOOKING_REMINDER_END,
        channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
        bookingId: "booking-333",
        recipients: {
          [CLIENT_RECIPIENT_TYPE]: {
            email: "client@example.com",
            phoneNumber: "+1234567890",
          },
        },
        templateData: {
          templateKind: BOOKING_REMINDER_TEMPLATE_KIND,
          bookingLegId: "leg-1",
          bookingId: "booking-333",
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
      },
    } as Job<NotificationJobData, NotificationResult[], string>;

    vi.mocked(emailService.sendEmail).mockResolvedValueOnce({
      data: { id: "email-msg-3" },
      error: null,
      headers: {},
    });
    const whatsappError = new Error("WhatsApp service unavailable");
    vi.mocked(whatsAppService.sendMessage).mockRejectedValueOnce(whatsappError);

    const results = await processor.process(job);

    expect(emailService.sendEmail).toHaveBeenCalledWith({
      to: "client@example.com",
      subject: "Booking End Reminder",
      html: "<html>Reminder email</html>",
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      channel: NotificationChannel.EMAIL,
      success: true,
      messageId: "email-sent",
      perRecipientResults: [
        {
          recipient: CLIENT_RECIPIENT_TYPE,
          email: "client@example.com",
          success: true,
          messageId: "email-msg-3",
        },
      ],
    });
    expect(results[1]).toEqual({
      channel: NotificationChannel.WHATSAPP,
      success: false,
      error: "WhatsApp service unavailable",
    });
  });

  it("should normalize serialized reviewDate before rendering review email", async () => {
    const reviewDateIso = "2026-02-17T00:00:00.000Z";
    const job = {
      id: "job-8",
      name: "send-notification",
      data: {
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
      },
    } as Job<NotificationJobData, NotificationResult[], string>;

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

  it("should preserve per-recipient results when one recipient fails", async () => {
    const job = {
      id: "job-9",
      name: "send-notification",
      data: {
        id: "notification-9",
        type: NotificationType.BOOKING_STATUS_CHANGE,
        channels: [NotificationChannel.EMAIL],
        bookingId: "booking-555",
        recipients: {
          [CLIENT_RECIPIENT_TYPE]: {
            email: "client@example.com",
          },
          [FLEET_OWNER_RECIPIENT_TYPE]: {
            email: "owner@example.com",
          },
        },
        templateData: {
          templateKind: BOOKING_STATUS_TEMPLATE_KIND,
          id: "booking-555",
          bookingReference: "BR-555",
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
      },
    } as Job<NotificationJobData, NotificationResult[], string>;

    vi.mocked(emailService.sendEmail)
      .mockResolvedValueOnce({
        data: { id: "email-msg-client" },
        error: null,
        headers: {},
      })
      .mockRejectedValueOnce(new Error("Fleet owner mailbox unavailable"));

    const results = await processor.process(job);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      channel: NotificationChannel.EMAIL,
      success: false,
      error: "One or more email recipients failed",
      perRecipientResults: [
        {
          recipient: CLIENT_RECIPIENT_TYPE,
          email: "client@example.com",
          success: true,
          messageId: "email-msg-client",
        },
        {
          recipient: FLEET_OWNER_RECIPIENT_TYPE,
          email: "owner@example.com",
          success: false,
          error: "Fleet owner mailbox unavailable",
        },
      ],
    });
  });
});
