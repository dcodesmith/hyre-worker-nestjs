import { Injectable } from "@nestjs/common";
import { NotificationOutboxEventType } from "@prisma/client";
import type { ReviewReceivedNotificationParams } from "../notification.interface";
import { NotificationService } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

const FLEET_OWNER_SUBTYPE = "REVIEW_RECEIVED_FLEET_OWNER";
const CHAUFFEUR_SUBTYPE = "REVIEW_RECEIVED_CHAUFFEUR";

@Injectable()
export class ReviewReceivedHandler implements OutboxEventHandler<ReviewReceivedNotificationParams> {
  readonly eventType = NotificationOutboxEventType.BOOKING_LIFECYCLE;

  constructor(private readonly notificationService: NotificationService) {}

  async buildEvents(input: ReviewReceivedNotificationParams): Promise<HandlerEvent[]> {
    const { owner, chauffeur } = this.notificationService.buildReviewReceivedJobData(input);

    return [
      {
        jobData: owner,
        dedupeKey: `review-received:${input.reviewId}:fleet-owner`,
        userId: input.owner.userId,
        subtype: FLEET_OWNER_SUBTYPE,
      },
      {
        jobData: chauffeur,
        dedupeKey: `review-received:${input.reviewId}:chauffeur`,
        userId: input.chauffeur.userId,
        subtype: CHAUFFEUR_SUBTYPE,
      },
    ];
  }
}
