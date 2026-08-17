import { Test, TestingModule } from "@nestjs/testing";
import { Job } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import * as emailTemplates from "../../templates/emails";
import { createBookingCompletionToken } from "../booking/booking-completion-token.helper";
import { DatabaseService } from "../database/database.service";
import { EmailService } from "../email/email.service";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  FLEET_OWNER_RECIPIENT_TYPE,
  OPERATIONS_RECIPIENT_TYPE,
} from "./notification.const";
import {
  NotificationAudience,
  NotificationChannel,
  NotificationJobData,
  NotificationResult,
  NotificationType,
} from "./notification.interface";
import { NotificationProcessor } from "./notification.processor";
import { PushService } from "./push.service";
import { PushTokenService } from "./push-token.service";
import {
  BOOKING_REMINDER_TEMPLATE_KIND,
  BOOKING_STATUS_TEMPLATE_KIND,
  FLIGHT_UPDATE_TEMPLATE_KIND,
  PAYOUT_STATUS_TEMPLATE_KIND,
  REFUND_STATUS_TEMPLATE_KIND,
  REVIEW_RECEIVED_TEMPLATE_KIND,
} from "./template-data.interface";
import { Template, WhatsAppService } from "./whatsapp.service";

describe("NotificationProcessor", () => {
  let processor: NotificationProcessor;
  let emailService: EmailService;
  let whatsAppService: WhatsAppService;
  let pushService: PushService;
  let pushTokenService: PushTokenService;
  let databaseService: DatabaseService;
  let logger: PinoLogger;

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

  const pushTemplateData: NotificationJobData["templateData"] = {
    templateKind: BOOKING_STATUS_TEMPLATE_KIND,
    id: "booking-push",
    bookingReference: "BR-PUSH",
    customerName: "Push Customer",
    ownerName: "Owner",
    chauffeurName: "Chauffeur",
    chauffeurPhoneNumber: "1234567890",
    carName: "Car",
    pickupLocation: "Pickup",
    returnLocation: "Return",
    startDate: "2026-07-27",
    endDate: "2026-07-28",
    totalAmount: "10000",
    title: "Booking update",
    status: "confirmed",
    cancellationReason: "",
    subject: "Booking update",
    oldStatus: "pending",
    newStatus: "confirmed",
  };

  const createAirportCompletionJobData = (
    overrides: Partial<NotificationJobData> = {},
  ): NotificationJobData => ({
    id: "airport-completion-notification",
    type: NotificationType.FLIGHT_ASSIGNMENT_SNAPSHOT,
    audience: NotificationAudience.CHAUFFEUR,
    channels: [NotificationChannel.EMAIL],
    bookingId: "booking-airport",
    airportCompletionLink: true,
    recipients: {
      [CHAUFFEUR_RECIPIENT_TYPE]: {
        userId: "chauffeur-1",
        email: "chauffeur@example.com",
      },
    },
    templateData: {
      templateKind: FLIGHT_UPDATE_TEMPLATE_KIND,
      subject: "Airport trip ready",
      recipientName: "Chauffeur",
      flightNumber: "BA74",
      bookingReference: "HYR-001",
      updateTitle: "Airport trip ready",
      updateBody: "After drop-off, use your secure link to complete this trip.",
      expectedArrival: "29 Jul 2026, 4:00 PM WAT",
      pickupActivationTime: "29 Jul 2026, 4:40 PM WAT",
      arrivalLocation: "LOS",
    },
    ...overrides,
  });

  beforeEach(async () => {
    process.env.SESSION_SECRET = "test-secret-at-least-32-characters-long";
    process.env.AUTH_BASE_URL = "https://api.example.com";
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
    vi.spyOn(emailTemplates, "renderFlightOperationalUpdateEmail").mockResolvedValue(
      "<html>Flight update email</html>",
    );
    vi.spyOn(emailTemplates, "renderPayoutStatusEmail").mockResolvedValue(
      "<html>Payout status email</html>",
    );
    vi.spyOn(emailTemplates, "renderRefundStatusEmail").mockResolvedValue(
      "<html>Refund status email</html>",
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
        {
          provide: PushService,
          useValue: {
            sendPushNotifications: vi.fn(),
          },
        },
        {
          provide: PushTokenService,
          useValue: {
            getActiveTokensForUsers: vi.fn().mockResolvedValue({}),
            revokeTokens: vi.fn(),
          },
        },
        {
          provide: DatabaseService,
          useValue: {
            booking: {
              findUnique: vi.fn(),
            },
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    processor = module.get<NotificationProcessor>(NotificationProcessor);
    emailService = module.get<EmailService>(EmailService);
    whatsAppService = module.get<WhatsAppService>(WhatsAppService);
    pushService = module.get<PushService>(PushService);
    pushTokenService = module.get<PushTokenService>(PushTokenService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    logger = module.get<PinoLogger>(PinoLogger);
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
          channel: NotificationChannel.EMAIL,
          email: "client@example.com",
          success: true,
          messageId: "email-msg-1",
        },
      ],
    });
  });

  it("sends failed payout notifications only to operations email", async () => {
    const job = createJob("payout-failed-job", {
      id: "payout-status-payout-123-failed",
      type: NotificationType.PAYOUT_STATUS_CHANGED,
      audience: NotificationAudience.OPERATIONS,
      channels: [NotificationChannel.EMAIL],
      bookingId: "booking-123",
      recipients: {
        [OPERATIONS_RECIPIENT_TYPE]: {
          email: "operations@tripdly.com",
        },
      },
      templateData: {
        templateKind: PAYOUT_STATUS_TEMPLATE_KIND,
        subject: "Payout failed for booking BR-123",
        status: "FAILED",
        recipientName: "Operations team",
        amount: "₦15,000.00",
        bookingReference: "BR-123",
        payoutTransactionId: "payout-123",
        failureReason: "Account blocked",
      },
    });
    vi.mocked(emailService.sendEmail).mockResolvedValueOnce({
      data: { id: "email-msg-ops" },
      error: null,
      headers: {},
    });

    await expect(processor.process(job)).resolves.toHaveLength(1);

    expect(emailService.sendEmail).toHaveBeenCalledExactlyOnceWith({
      to: "operations@tripdly.com",
      subject: "Payout failed for booking BR-123",
      html: "<html>Payout status email</html>",
    });
    expect(whatsAppService.sendMessage).not.toHaveBeenCalled();
  });

  it("sends failed refund notifications only to operations email", async () => {
    const job = createJob("refund-failed-job", {
      id: "refund-status-refund-123-refund_failed",
      type: NotificationType.REFUND_STATUS_CHANGED,
      audience: NotificationAudience.OPERATIONS,
      channels: [NotificationChannel.EMAIL],
      bookingId: "booking-123",
      recipients: {
        [OPERATIONS_RECIPIENT_TYPE]: {
          email: "operations@tripdly.com",
        },
      },
      templateData: {
        templateKind: REFUND_STATUS_TEMPLATE_KIND,
        subject: "Refund failed for booking BR-123",
        status: "REFUND_FAILED",
        recipientName: "Operations team",
        amount: "₦15,000.00",
        bookingReference: "BR-123",
        paymentId: "payment-123",
        refundId: "refund-123",
        failureReason: "Provider rejected refund",
      },
    });
    vi.mocked(emailService.sendEmail).mockResolvedValueOnce({
      data: { id: "email-msg-refund-ops" },
      error: null,
      headers: {},
    });

    await expect(processor.process(job)).resolves.toHaveLength(1);

    expect(emailService.sendEmail).toHaveBeenCalledExactlyOnceWith({
      to: "operations@tripdly.com",
      subject: "Refund failed for booking BR-123",
      html: "<html>Refund status email</html>",
    });
    expect(whatsAppService.sendMessage).not.toHaveBeenCalled();
    expect(pushService.sendPushNotifications).not.toHaveBeenCalled();
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

  it("renders operational flight updates for email and WhatsApp", async () => {
    const templateData: NotificationJobData["templateData"] = {
      templateKind: FLIGHT_UPDATE_TEMPLATE_KIND,
      subject: "Pickup flight delayed",
      recipientName: "Fleet Owner",
      flightNumber: "BA74",
      bookingReference: "HYR-001",
      updateTitle: "Pickup flight delayed",
      updateBody: "BA74 is delayed by 45 minutes.",
      expectedArrival: "29 Jul 2026, 4:00 PM WAT",
      pickupActivationTime: "29 Jul 2026, 4:40 PM WAT",
      arrivalLocation: "LOS, Terminal 2, Gate G2",
    };
    const job = createJob("flight-job", {
      id: "flight-notification-1",
      type: NotificationType.FLIGHT_DELAYED,
      audience: NotificationAudience.FLEET_OWNER,
      channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
      bookingId: "booking-1",
      recipients: {
        [FLEET_OWNER_RECIPIENT_TYPE]: {
          userId: "owner-1",
          email: "owner@example.com",
          phoneNumber: "+2348012345678",
        },
      },
      templateData,
    });
    vi.mocked(emailService.sendEmail).mockResolvedValueOnce({
      data: { id: "email-flight-1" },
      error: null,
      headers: {},
    });
    vi.mocked(whatsAppService.sendMessage).mockResolvedValueOnce(undefined);

    await processor.process(job);

    expect(emailTemplates.renderFlightOperationalUpdateEmail).toHaveBeenCalledWith(templateData);
    expect(emailService.sendEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      subject: "Pickup flight delayed",
      html: "<html>Flight update email</html>",
    });
    expect(whatsAppService.sendMessage).toHaveBeenCalledWith({
      to: "+2348012345678",
      templateKey: Template.FlightOperationalUpdate,
      variables: {
        "1": "Fleet Owner",
        "2": "BA74",
        "3": "HYR-001",
        "4": "Pickup flight delayed",
        "5": "BA74 is delayed by 45 minutes.",
        "6": "29 Jul 2026, 4:00 PM WAT",
        "7": "29 Jul 2026, 4:40 PM WAT",
        "8": "LOS, Terminal 2, Gate G2",
      },
    });
  });

  it("resolves an airport completion URL only when the worker dispatches it", async () => {
    const expiresAt = new Date("2099-08-18T12:00:00.000Z");
    const completionToken = createBookingCompletionToken(
      "booking-airport",
      expiresAt,
      process.env.SESSION_SECRET,
    );
    vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce({
      completionTokenHash: completionToken.tokenHash,
      completionTokenExpiresAt: expiresAt,
    } as never);
    const job = createJob("airport-completion-job", createAirportCompletionJobData());
    vi.mocked(emailService.sendEmail).mockResolvedValueOnce({
      data: { id: "email-airport-1" },
      error: null,
      headers: {},
    });

    await processor.process(job);

    expect(emailTemplates.renderFlightOperationalUpdateEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        updateBody: expect.stringContaining(
          `https://api.example.com/chauffeur/airport-trips/booking-airport/complete?token=${completionToken.token}`,
        ),
      }),
    );
    expect(JSON.stringify(job.data)).not.toContain(completionToken.token);
  });

  it("rejects an airport completion link for a non-chauffeur audience", async () => {
    const job = createJob(
      "airport-completion-customer-job",
      createAirportCompletionJobData({ audience: NotificationAudience.CUSTOMER }),
    );

    await expect(processor.process(job)).rejects.toThrow(
      "Airport completion links can only be delivered to chauffeur recipients",
    );
    expect(databaseService.booking.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an airport completion link with a non-chauffeur recipient", async () => {
    const job = createJob(
      "airport-completion-mixed-job",
      createAirportCompletionJobData({
        recipients: {
          [CHAUFFEUR_RECIPIENT_TYPE]: {
            userId: "chauffeur-1",
            email: "chauffeur@example.com",
          },
          [CLIENT_RECIPIENT_TYPE]: {
            userId: "customer-1",
            email: "customer@example.com",
          },
        },
      }),
    );

    await expect(processor.process(job)).rejects.toThrow(
      "Airport completion links can only be delivered to chauffeur recipients",
    );
    expect(databaseService.booking.findUnique).not.toHaveBeenCalled();
  });

  it("uses the booking status WhatsApp template for booking updates", async () => {
    const job = createJob("job-booking-updated-whatsapp", {
      id: "notification-booking-updated-whatsapp",
      type: NotificationType.BOOKING_UPDATED,
      audience: NotificationAudience.CUSTOMER,
      channels: [NotificationChannel.WHATSAPP],
      bookingId: "booking-updated",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          phoneNumber: "+1234567890",
        },
      },
      templateData: pushTemplateData,
    });

    await processor.process(job);

    expect(whatsAppService.sendMessage).toHaveBeenCalledWith({
      to: "+1234567890",
      templateKey: Template.BookingStatusUpdate,
      variables: expect.objectContaining({
        "1": "Push Customer",
        "2": "Car",
        "3": "Booking update",
      }),
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
          channel: NotificationChannel.EMAIL,
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

  it("processes a typed PUSH payload and treats invalid tokens as non-retryable", async () => {
    const job = createJob("job-11", {
      id: "notification-11",
      type: NotificationType.CHAUFFEUR_ASSIGNED,
      channels: [NotificationChannel.PUSH],
      bookingId: "booking-111",
      pushPayload: {
        title: "Your chauffeur has been assigned",
        body: "Your chauffeur for a trip has been assigned.",
        data: {
          type: NotificationType.CHAUFFEUR_ASSIGNED,
          target: {
            kind: "booking",
            bookingId: "booking-111",
          },
        },
      },
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          pushTokens: ["ExponentPushToken[a]", "ExponentPushToken[b]"],
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
        title: "been assigned a chauffeur",
        status: "chauffeur assigned",
        cancellationReason: "",
        subject: "Your chauffeur has been assigned",
        oldStatus: "confirmed",
        newStatus: "chauffeur_assigned",
      },
    });

    vi.mocked(pushService.sendPushNotifications).mockResolvedValueOnce({
      sent: 1,
      failed: 0,
      invalidTokens: ["ExponentPushToken[b]"],
    });

    await expect(processor.process(job)).resolves.toEqual([
      {
        channel: NotificationChannel.PUSH,
        success: true,
        messageId: "push-sent",
        perRecipientResults: [
          {
            recipient: CLIENT_RECIPIENT_TYPE,
            channel: NotificationChannel.PUSH,
            pushToken: "ExponentPushToken[a]",
            success: true,
            messageId: "push-sent",
          },
          {
            recipient: CLIENT_RECIPIENT_TYPE,
            channel: NotificationChannel.PUSH,
            pushToken: "ExponentPushToken[b]",
            success: false,
            error: "Device not registered",
            pushResponse: {
              code: "DeviceNotRegistered",
              retryable: false,
              message: "Device not registered",
            },
          },
        ],
      },
    ]);

    expect(pushService.sendPushNotifications).toHaveBeenCalledWith({
      tokens: ["ExponentPushToken[a]", "ExponentPushToken[b]"],
      title: "Your chauffeur has been assigned",
      body: "Your chauffeur for a trip has been assigned.",
      data: {
        type: NotificationType.CHAUFFEUR_ASSIGNED,
        target: {
          kind: "booking",
          bookingId: "booking-111",
        },
      },
    });
    expect(pushTokenService.revokeTokens).toHaveBeenCalledWith(["ExponentPushToken[b]"]);
  });

  it("resolves active push tokens from the recipient user ID at delivery time", async () => {
    const job = createJob("job-late-token", {
      id: "notification-late-token",
      type: NotificationType.BOOKING_STATUS_CHANGE,
      audience: NotificationAudience.CUSTOMER,
      channels: [NotificationChannel.PUSH],
      bookingId: "booking-push",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          userId: "customer-late-token",
        },
      },
      templateData: pushTemplateData,
    });
    vi.mocked(pushTokenService.getActiveTokensForUsers).mockResolvedValueOnce({
      "customer-late-token": ["ExponentPushToken[latest]"],
    });
    vi.mocked(pushService.sendPushNotifications).mockResolvedValueOnce({
      sent: 1,
      failed: 0,
      invalidTokens: [],
    });

    await expect(processor.process(job)).resolves.toEqual([
      expect.objectContaining({
        channel: NotificationChannel.PUSH,
        success: true,
      }),
    ]);

    expect(pushTokenService.getActiveTokensForUsers).toHaveBeenCalledWith(["customer-late-token"]);
    expect(pushService.sendPushNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: ["ExponentPushToken[latest]"],
      }),
    );
  });

  it("logs when no active push tokens are found", async () => {
    const job = createJob("job-no-token", {
      id: "notification-no-token",
      type: NotificationType.BOOKING_STATUS_CHANGE,
      audience: NotificationAudience.CUSTOMER,
      channels: [NotificationChannel.PUSH],
      bookingId: "booking-push",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          userId: "customer-no-token",
        },
      },
      templateData: pushTemplateData,
    });

    await expect(processor.process(job)).resolves.toEqual([]);

    expect(logger.debug).toHaveBeenCalledWith(
      {
        bookingId: "booking-push",
        type: NotificationType.BOOKING_STATUS_CHANGE,
        recipientCount: 1,
      },
      "Push notification skipped: no active tokens found",
    );
    expect(pushService.sendPushNotifications).not.toHaveBeenCalled();
  });

  it("does not deliver push to an explicitly unsupported audience", async () => {
    const job = createJob("job-owner-push", {
      id: "notification-owner-push",
      type: NotificationType.BOOKING_STATUS_CHANGE,
      audience: NotificationAudience.FLEET_OWNER,
      channels: [NotificationChannel.PUSH],
      bookingId: "booking-push",
      recipients: {
        [FLEET_OWNER_RECIPIENT_TYPE]: {
          userId: "fleet-owner-1",
        },
      },
      templateData: pushTemplateData,
    });

    await expect(processor.process(job)).resolves.toEqual([]);
    expect(pushTokenService.getActiveTokensForUsers).not.toHaveBeenCalled();
    expect(pushService.sendPushNotifications).not.toHaveBeenCalled();
  });

  it("should fail PUSH channel with retryable error when only retryable push errors exist", async () => {
    const job = createJob("job-12", {
      id: "notification-12",
      type: NotificationType.CHAUFFEUR_ASSIGNED,
      channels: [NotificationChannel.PUSH],
      bookingId: "booking-112",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          pushTokens: ["ExponentPushToken[c]"],
        },
      },
      templateData: {
        templateKind: BOOKING_STATUS_TEMPLATE_KIND,
        id: "booking-112",
        bookingReference: "BR-112",
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
        title: "been assigned a chauffeur",
        status: "chauffeur assigned",
        cancellationReason: "",
        subject: "Your chauffeur has been assigned",
        oldStatus: "confirmed",
        newStatus: "chauffeur_assigned",
      },
    });

    vi.mocked(pushService.sendPushNotifications).mockResolvedValueOnce({
      sent: 0,
      failed: 1,
      invalidTokens: [],
      errors: [{ code: "MessageRateExceeded", retryable: true }],
    });

    await expect(processor.process(job)).rejects.toThrow(
      "Notification channel delivery failed for notification notification-12: push",
    );
  });

  it("should fail PUSH channel without retries for non-retryable errors", async () => {
    const job = createJob("job-12b", {
      id: "notification-12b",
      type: NotificationType.CHAUFFEUR_ASSIGNED,
      channels: [NotificationChannel.PUSH],
      bookingId: "booking-112b",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          pushTokens: ["ExponentPushToken[d]"],
        },
      },
      templateData: {
        templateKind: BOOKING_STATUS_TEMPLATE_KIND,
        id: "booking-112b",
        bookingReference: "BR-112b",
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
        title: "been assigned a chauffeur",
        status: "chauffeur assigned",
        cancellationReason: "",
        subject: "Your chauffeur has been assigned",
        oldStatus: "confirmed",
        newStatus: "chauffeur_assigned",
      },
    });

    vi.mocked(pushService.sendPushNotifications).mockResolvedValueOnce({
      sent: 0,
      failed: 1,
      invalidTokens: [],
      errors: [{ code: "InvalidCredentials", retryable: false }],
    });

    await expect(processor.process(job)).rejects.toThrow(
      "Notification channel delivery failed for notification notification-12b: push",
    );
  });

  it("should fail PUSH channel when blocking non-retryable errors exist even with failed=0", async () => {
    const job = createJob("job-12c", {
      id: "notification-12c",
      type: NotificationType.CHAUFFEUR_ASSIGNED,
      channels: [NotificationChannel.PUSH],
      bookingId: "booking-112c",
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          pushTokens: ["ExponentPushToken[e]"],
        },
      },
      templateData: {
        templateKind: BOOKING_STATUS_TEMPLATE_KIND,
        id: "booking-112c",
        bookingReference: "BR-112c",
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
        title: "been assigned a chauffeur",
        status: "chauffeur assigned",
        cancellationReason: "",
        subject: "Your chauffeur has been assigned",
        oldStatus: "confirmed",
        newStatus: "chauffeur_assigned",
      },
    });

    vi.mocked(pushService.sendPushNotifications).mockResolvedValueOnce({
      sent: 0,
      failed: 0,
      invalidTokens: [],
      errors: [{ code: "InvalidCredentials", retryable: false }],
    });

    await expect(processor.process(job)).rejects.toThrow(
      "Notification channel delivery failed for notification notification-12c: push",
    );
  });

  it("should succeed PUSH channel and revoke when ALL push tokens are invalid", async () => {
    const job = createJob("job-13", {
      id: "notification-13",
      type: NotificationType.CHAUFFEUR_ASSIGNED,
      channels: [NotificationChannel.PUSH],
      bookingId: "booking-113",
      pushPayload: {
        title: "t",
        body: "b",
        data: {
          type: NotificationType.CHAUFFEUR_ASSIGNED,
          target: {
            kind: "booking",
            bookingId: "booking-113",
          },
        },
      },
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          pushTokens: ["ExponentPushToken[x]", "ExponentPushToken[y]"],
        },
      },
      templateData: {
        templateKind: BOOKING_STATUS_TEMPLATE_KIND,
        id: "booking-113",
        bookingReference: "BR-113",
        customerName: "John Doe",
        ownerName: "Owner",
        chauffeurName: "Chauffeur",
        chauffeurPhoneNumber: "1234567890",
        carName: "Car",
        pickupLocation: "p",
        returnLocation: "r",
        startDate: "2024-01-01",
        endDate: "2024-01-02",
        totalAmount: "10000",
        title: "been assigned a chauffeur",
        status: "chauffeur assigned",
        cancellationReason: "",
        subject: "Your chauffeur has been assigned",
        oldStatus: "confirmed",
        newStatus: "chauffeur_assigned",
      },
    });

    vi.mocked(pushService.sendPushNotifications).mockResolvedValueOnce({
      sent: 0,
      failed: 0,
      invalidTokens: ["ExponentPushToken[x]", "ExponentPushToken[y]"],
    });

    await expect(processor.process(job)).resolves.toEqual([
      {
        channel: NotificationChannel.PUSH,
        success: true,
        messageId: undefined,
        perRecipientResults: [
          {
            recipient: CLIENT_RECIPIENT_TYPE,
            channel: NotificationChannel.PUSH,
            pushToken: "ExponentPushToken[x]",
            success: false,
            error: "Device not registered",
            pushResponse: {
              code: "DeviceNotRegistered",
              retryable: false,
              message: "Device not registered",
            },
          },
          {
            recipient: CLIENT_RECIPIENT_TYPE,
            channel: NotificationChannel.PUSH,
            pushToken: "ExponentPushToken[y]",
            success: false,
            error: "Device not registered",
            pushResponse: {
              code: "DeviceNotRegistered",
              retryable: false,
              message: "Device not registered",
            },
          },
        ],
      },
    ]);
    expect(pushTokenService.revokeTokens).toHaveBeenCalledWith([
      "ExponentPushToken[x]",
      "ExponentPushToken[y]",
    ]);
  });
});
