import { describe, expect, it } from "vitest";
import { NotificationType } from "./notification.interface";
import { pushNotificationDataSchema } from "./notification-target";

describe("notification target contract", () => {
  it("rejects flat or malformed notification data", () => {
    expect(
      pushNotificationDataSchema.safeParse({
        type: NotificationType.BOOKING_EXTENSION_CONFIRMED,
        bookingId: "booking-2",
      }).success,
    ).toBe(false);
    expect(
      pushNotificationDataSchema.safeParse({
        type: NotificationType.BOOKING_CONFIRMED,
        target: { kind: "booking", bookingId: "" },
      }).success,
    ).toBe(false);
    expect(
      pushNotificationDataSchema.safeParse({
        type: NotificationType.REFERRAL_REWARD_RELEASED,
        target: { kind: "referrals", bookingId: "booking-2" },
      }).success,
    ).toBe(false);
  });
});
