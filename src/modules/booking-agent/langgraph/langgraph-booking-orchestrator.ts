import type {
  BookingDraft,
  VehicleSearchOption,
  WhatsAppGuestIdentity,
} from "./langgraph.interface";

export function buildGuestIdentity(
  phoneE164: string,
  profileName: string | null,
): WhatsAppGuestIdentity {
  const phoneDigits = phoneE164.replaceAll(/\D/g, "");
  return {
    guestEmail: `whatsapp.${phoneDigits}@tripdly.com`,
    guestName: profileName ?? "WhatsApp Customer",
    guestPhone: phoneE164,
  };
}

export function buildBookingInputFromDraft(
  draft: BookingDraft,
  selectedOption: VehicleSearchOption,
  guestIdentity: WhatsAppGuestIdentity,
) {
  const startDate = draft.pickupDate ? new Date(draft.pickupDate) : new Date();
  const endDate = draft.dropoffDate ? new Date(draft.dropoffDate) : new Date();

  if (draft.pickupTime) {
    parseAndApplyPickupTime(startDate, draft.pickupTime);
  }

  const sameLocation = draft.pickupLocation === draft.dropoffLocation;

  return {
    input: {
      carId: selectedOption.id,
      startDate,
      endDate,
      pickupAddress: draft.pickupLocation ?? "",
      bookingType: draft.bookingType ?? "DAY",
      pickupTime: normalizePickupTimeTo12Hour(draft.pickupTime ?? "9:00 AM"),
      flightNumber: draft.flightNumber,
      includeSecurityDetail: false,
      requiresFullTank: false,
      useCredits: 0,
      // Let BookingCreationService compute authoritative totals server-side.
      // Avoid passing estimated totals from search cards, which may be rounded for display.
      guestEmail: guestIdentity.guestEmail,
      guestName: guestIdentity.guestName,
      guestPhone: guestIdentity.guestPhone,
      ...(sameLocation
        ? { sameLocation: true as const }
        : {
            sameLocation: false as const,
            dropOffAddress: draft.dropoffLocation ?? draft.pickupLocation ?? "",
          }),
    },
    normalizedStartDate: startDate,
    normalizedEndDate: endDate,
  };
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

function normalizePickupTimeTo12Hour(pickupTime: string): string {
  if (/\s*(AM|PM)$/i.test(pickupTime)) {
    return pickupTime;
  }

  const time24Match = /^(\d{1,2}):(\d{2})$/.exec(pickupTime);
  if (time24Match) {
    let hours = Number.parseInt(time24Match[1], 10);
    const minutes = Number.parseInt(time24Match[2], 10);

    const period = hours >= 12 ? "PM" : "AM";
    if (hours === 0) {
      hours = 12;
    } else if (hours > 12) {
      hours -= 12;
    }

    const minuteStr = minutes > 0 ? `:${minutes.toString().padStart(2, "0")}` : "";
    return `${hours}${minuteStr} ${period}`;
  }

  return pickupTime;
}
