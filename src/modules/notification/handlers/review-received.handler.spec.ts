import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationOutboxEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotificationAudience,
  NotificationChannel,
  NotificationType,
  type ReviewReceivedNotificationParams,
} from "../notification.interface";
import { NotificationService } from "../notification.service";
import { ReviewReceivedHandler } from "./review-received.handler";

describe("ReviewReceivedHandler", () => {
  let handler: ReviewReceivedHandler;
  let notificationService: {
    buildReviewReceivedJobData: ReturnType<typeof vi.fn>;
  };

  const input: ReviewReceivedNotificationParams = {
    reviewId: "review-1",
    bookingId: "booking-1",
    owner: {
      userId: "owner-1",
      name: "Owner",
      email: "owner@example.com",
    },
    chauffeur: {
      userId: "chauffeur-1",
      name: "Chauffeur",
      email: "chauffeur@example.com",
    },
    review: {
      customerName: "Customer",
      bookingReference: "BK-12345678",
      carName: "Toyota Camry (2023)",
      overallRating: 5,
      carRating: 5,
      chauffeurRating: 4,
      serviceRating: 5,
      comment: "Excellent trip",
      reviewDate: new Date("2026-07-28T12:00:00.000Z"),
    },
  };

  beforeEach(async () => {
    notificationService = { buildReviewReceivedJobData: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewReceivedHandler,
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    handler = module.get(ReviewReceivedHandler);
  });

  it("emits durable owner and chauffeur email events with deterministic keys", async () => {
    const ownerJobData = {
      id: "review-received-owner-review-1",
      type: NotificationType.REVIEW_RECEIVED,
      audience: NotificationAudience.FLEET_OWNER,
      channels: [NotificationChannel.EMAIL],
      bookingId: "booking-1",
      recipients: { fleetOwner: { userId: "owner-1", email: "owner@example.com" } },
      templateData: {},
    };
    const chauffeurJobData = {
      id: "review-received-chauffeur-review-1",
      type: NotificationType.REVIEW_RECEIVED,
      audience: NotificationAudience.CHAUFFEUR,
      channels: [NotificationChannel.EMAIL],
      bookingId: "booking-1",
      recipients: {
        chauffeur: { userId: "chauffeur-1", email: "chauffeur@example.com" },
      },
      templateData: {},
    };
    notificationService.buildReviewReceivedJobData.mockReturnValueOnce({
      owner: ownerJobData,
      chauffeur: chauffeurJobData,
    });

    const events = await handler.buildEvents(input);

    expect(handler.eventType).toBe(NotificationOutboxEventType.BOOKING_LIFECYCLE);
    expect(notificationService.buildReviewReceivedJobData).toHaveBeenCalledWith(input);
    expect(events).toEqual([
      {
        jobData: ownerJobData,
        dedupeKey: "review-received:review-1:fleet-owner",
        userId: "owner-1",
        subtype: "REVIEW_RECEIVED_FLEET_OWNER",
      },
      {
        jobData: chauffeurJobData,
        dedupeKey: "review-received:review-1:chauffeur",
        userId: "chauffeur-1",
        subtype: "REVIEW_RECEIVED_CHAUFFEUR",
      },
    ]);
  });
});
