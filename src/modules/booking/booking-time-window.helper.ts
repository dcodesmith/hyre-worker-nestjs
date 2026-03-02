import type { BookingType } from "@prisma/client";
import { addHours, differenceInCalendarDays } from "date-fns";

type NormalizationInput = {
  bookingType: BookingType;
  startDate: Date;
  endDate: Date;
  pickupTime?: string;
};

export function normalizeBookingTimeWindow(input: NormalizationInput): {
  startDate: Date;
  endDate: Date;
} {
  const startDate = new Date(input.startDate);
  const endDate = new Date(input.endDate);
  const pickupTime = input.pickupTime ?? "9:00 AM";

  switch (input.bookingType) {
    case "AIRPORT_PICKUP":
      return { startDate, endDate };
    case "NIGHT":
      startDate.setHours(23, 0, 0, 0);
      endDate.setHours(5, 0, 0, 0);
      return { startDate, endDate };
    case "FULL_DAY": {
      parseAndApplyPickupTime(startDate, pickupTime);
      const daySpan = Math.max(1, differenceInCalendarDays(endDate, input.startDate));
      return { startDate, endDate: addHours(startDate, 24 * daySpan) };
    }
    default: {
      parseAndApplyPickupTime(startDate, pickupTime);
      const adjustedEndDate = new Date(endDate);
      adjustedEndDate.setHours(startDate.getHours() + 12, startDate.getMinutes(), 0, 0);
      return { startDate, endDate: adjustedEndDate };
    }
  }
}

function parseAndApplyPickupTime(date: Date, pickupTime: string): void {
  const time24Match = /^(\d{1,2}):(\d{2})$/.exec(pickupTime);
  if (time24Match) {
    const hours = Number.parseInt(time24Match[1], 10);
    const minutes = Number.parseInt(time24Match[2], 10);
    date.setHours(hours, minutes, 0, 0);
    return;
  }

  const time12Match = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(pickupTime);
  if (time12Match) {
    let hours = Number.parseInt(time12Match[1], 10);
    const minutes = time12Match[2] ? Number.parseInt(time12Match[2], 10) : 0;
    const period = time12Match[3].toUpperCase();

    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;

    date.setHours(hours, minutes, 0, 0);
  }
}
