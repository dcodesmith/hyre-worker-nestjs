import { Injectable } from "@nestjs/common";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import type { ReferralRewardReleasedNotificationParams } from "../notification.interface";
import { NotificationService } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

const REFERRAL_REWARD_RELEASED_SUBTYPE = "REFERRAL_REWARD_RELEASED";

@Injectable()
export class ReferralRewardReleasedHandler
  implements OutboxEventHandler<ReferralRewardReleasedNotificationParams>
{
  readonly eventType = NotificationOutboxEventType.BOOKING_LIFECYCLE;

  constructor(private readonly notificationService: NotificationService) {}

  async buildEvents(input: ReferralRewardReleasedNotificationParams): Promise<HandlerEvent[]> {
    const jobData = this.notificationService.buildReferralRewardReleasedJobData(input);
    const dedupeKey = `referral-reward-released:${input.rewardId}:${input.releasedAt.toISOString()}`;

    return [
      {
        jobData,
        dedupeKey,
        userId: input.referrerUserId,
        subtype: REFERRAL_REWARD_RELEASED_SUBTYPE,
        inbox: {
          userId: input.referrerUserId,
          type: NotificationInboxType.BOOKING_LIFECYCLE,
          title: jobData.pushPayload?.title ?? "Referral reward earned",
          body: jobData.pushPayload?.body ?? "Your referral reward is now available.",
          payload: {
            rewardId: input.rewardId,
            bookingId: input.bookingId,
            amount: input.amount,
            target: { kind: "referrals" },
          },
        },
      },
    ];
  }
}
