import { describe, expect, it } from "vitest";
import { NotificationType } from "./notification.interface";
import { createBookingNotificationData, pushNotificationDataSchema } from "./notification-target";

describe("notification target contract", () => {
  it("builds the typed booking target", () => {
    expect(createBookingNotificationData(NotificationType.BOOKING_UPDATED, "booking-1")).toEqual({
      type: NotificationType.BOOKING_UPDATED,
      target: {
        kind: "booking",
        bookingId: "booking-1",
      },
    });
  });

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
  });
});
