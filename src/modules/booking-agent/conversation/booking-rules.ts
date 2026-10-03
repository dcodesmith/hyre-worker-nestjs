import { addDays, format, parseISO } from "date-fns";
import { normalizeControlText } from "./control-intent.policy";
import type { BookingDraft, UserIntent } from "./conversation.interface";

export function shouldApplyDraftPatch(intent: UserIntent): boolean {
  return (
    intent === "provide_info" ||
    intent === "update_info" ||
    intent === "select_option" ||
    intent === "new_booking"
  );
}

export function hasDraftChanged(oldDraft: BookingDraft, newDraft: BookingDraft): boolean {
  const keyFields: (keyof BookingDraft)[] = [
    "pickupDate",
    "pickupTime",
    "dropoffDate",
    "durationDays",
    "bookingType",
    "pickupLocation",
    "dropoffLocation",
    "vehicleType",
    "serviceTier",
    "color",
    "make",
    "model",
    "flightNumber",
  ];

  return keyFields.some((field) => oldDraft[field] !== newDraft[field]);
}

export function clearDerivedAirportFields(draft: BookingDraft): BookingDraft {
  const cleared = { ...draft };
  delete cleared.pickupDateTime;
  delete cleared.dropoffDateTime;
  delete cleared.pickupTime;
  delete cleared.pickupLocation;
  delete cleared.dropoffDate;
  delete cleared.durationDays;
  return cleared;
}

export function applyDerivedDraftFields(
  draft: BookingDraft,
  inboundMessage: string,
  draftPatch: Partial<BookingDraft> = {},
): BookingDraft {
  const updatedDraft: BookingDraft = { ...draft };
  const extractedDropoffLocation = draftPatch.dropoffLocation;
  const hasNewExplicitDropoff =
    extractedDropoffLocation && !hasSameLocationInstruction(extractedDropoffLocation);

  if (
    updatedDraft.pickupLocation &&
    hasSameLocationInstruction(inboundMessage) &&
    !hasNewExplicitDropoff
  ) {
    updatedDraft.dropoffLocation = updatedDraft.pickupLocation;
  }

  if (updatedDraft.bookingType === "NIGHT") {
    updatedDraft.pickupTime = "23:00";
  }

  const hasDurationDays =
    typeof updatedDraft.durationDays === "number" && updatedDraft.durationDays > 0;
  const shouldDefaultNightToOne =
    updatedDraft.bookingType === "NIGHT" && !hasDurationDays && !updatedDraft.dropoffDate;

  if (updatedDraft.pickupDate && (hasDurationDays || shouldDefaultNightToOne)) {
    const normalizedDurationDays = Math.max(updatedDraft.durationDays ?? 1, 1);
    const daysToAdd =
      updatedDraft.bookingType === "DAY"
        ? Math.max(normalizedDurationDays - 1, 0)
        : normalizedDurationDays;
    updatedDraft.dropoffDate = calculateDropoffDate(updatedDraft.pickupDate, daysToAdd);
  }

  return updatedDraft;
}

export function calculateDropoffDate(pickupDate: string, daysToAdd: number): string {
  const pickup = parseISO(pickupDate);
  const result = addDays(pickup, daysToAdd);
  return format(result, "yyyy-MM-dd");
}

export function getDurationUnitClarification(
  message: string,
  bookingType: BookingDraft["bookingType"],
): string | null {
  const durationMatches = [
    ...message.matchAll(
      /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(days?|nights?)\b/gi,
    ),
  ];
  const durationMatch = durationMatches[durationMatches.length - 1];
  if (!durationMatch || !bookingType || bookingType === "AIRPORT_PICKUP") {
    return null;
  }

  const quantity = durationMatch[1];
  const usesNights = durationMatch[2].toLowerCase().startsWith("night");
  if (bookingType === "NIGHT" ? usesNights : !usesNights) {
    return null;
  }

  if (bookingType === "NIGHT") {
    return `You mentioned a Night booking for ${quantity} days. Do you want a Night booking for ${quantity} nights, or a Day booking for ${quantity} days?`;
  }

  const bookingTypeLabel = bookingType === "FULL_DAY" ? "Full Day" : "Day";
  return `You mentioned a ${bookingTypeLabel} booking for ${quantity} nights. Do you want a ${bookingTypeLabel} booking for ${quantity} days, or a Night booking for ${quantity} nights?`;
}

export function hasSameLocationInstruction(message: string): boolean {
  const normalizedMessage = normalizeControlText(message);
  if (!normalizedMessage) {
    return false;
  }

  const sameLocationPhrases = [
    "same place",
    "same location",
    "same as pickup",
    "same as pick up",
    "same pickup location",
    "same pick up location",
    "drop me off at the same place",
    "dropoff same",
  ];

  return sameLocationPhrases.some((phrase) => normalizedMessage.includes(phrase));
}
