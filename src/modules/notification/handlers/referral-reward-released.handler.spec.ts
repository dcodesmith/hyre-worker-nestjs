import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferralRewardReleasedNotificationParams } from "../notification.interface";
import { NotificationService } from "../notification.service";
import { ReferralRewardReleasedHandler } from "./referral-reward-released.handler";

describe("ReferralRewardReleasedHandler", () => {
  let handler: ReferralRewardReleasedHandler;
  let notificationService: {
    buildReferralRewardReleasedJobData: ReturnType<typeof vi.fn>;
  };

  const input: ReferralRewardReleasedNotificationParams = {
    rewardId: "reward-1",
    bookingId: "booking-1",
    referrerUserId: "referrer-1",
    amount: 2500,
    releasedAt: new Date("2026-07-29T12:00:00.000Z"),
  };

  beforeEach(async () => {
    notificationService = {
      buildReferralRewardReleasedJobData: vi.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralRewardReleasedHandler,
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    handler = module.get(ReferralRewardReleasedHandler);
  });

  it("builds one durable customer push and inbox event", async () => {
    const jobData = {
      pushPayload: {
        title: "Referral reward earned",
        body: "₦2,500.00 has been added to your referral balance.",
      },
    };
    notificationService.buildReferralRewardReleasedJobData.mockReturnValueOnce(jobData);

    await expect(handler.buildEvents(input)).resolves.toEqual([
      {
        jobData,
        dedupeKey: "referral-reward-released:reward-1:2026-07-29T12:00:00.000Z",
        userId: "referrer-1",
        subtype: "REFERRAL_REWARD_RELEASED",
        inbox: {
          userId: "referrer-1",
          type: NotificationInboxType.BOOKING_LIFECYCLE,
          title: "Referral reward earned",
          body: "₦2,500.00 has been added to your referral balance.",
          payload: {
            rewardId: "reward-1",
            bookingId: "booking-1",
            amount: 2500,
            target: { kind: "referrals" },
          },
        },
      },
    ]);
    expect(handler.eventType).toBe(NotificationOutboxEventType.BOOKING_LIFECYCLE);
    expect(notificationService.buildReferralRewardReleasedJobData).toHaveBeenCalledWith(input);
  });
});
