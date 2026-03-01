import { addDays, format, parseISO } from "date-fns";
import { REQUIRED_SEARCH_FIELDS } from "./langgraph.const";
import type { BookingDraft, UserIntent } from "./langgraph.interface";
import { normalizeControlText } from "./langgraph-control-intent.policy";

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
    "dropoffDate",
    "bookingType",
    "pickupLocation",
    "vehicleType",
  ];

  return keyFields.some((field) => oldDraft[field] !== newDraft[field]);
}

export function getMissingRequiredFields(draft: BookingDraft): string[] {
  return REQUIRED_SEARCH_FIELDS.filter((field) => !draft[field]);
}

export function applyDerivedDraftFields(draft: BookingDraft, inboundMessage: string): BookingDraft {
  const updatedDraft: BookingDraft = { ...draft };

  if (
    !updatedDraft.dropoffLocation &&
    updatedDraft.pickupLocation &&
    hasSameLocationInstruction(inboundMessage)
  ) {
    updatedDraft.dropoffLocation = updatedDraft.pickupLocation;
  }

  if (!updatedDraft.dropoffDate && updatedDraft.pickupDate && updatedDraft.durationDays) {
    updatedDraft.dropoffDate = calculateDropoffDate(
      updatedDraft.pickupDate,
      updatedDraft.durationDays,
    );
  }

  if (updatedDraft.bookingType === "NIGHT") {
    updatedDraft.pickupTime = "23:00";
    if (!updatedDraft.dropoffDate && updatedDraft.pickupDate) {
      const daysToAdd = updatedDraft.durationDays ?? 1;
      updatedDraft.dropoffDate = calculateDropoffDate(updatedDraft.pickupDate, daysToAdd);
    }
  }

  return updatedDraft;
}

export function calculateDropoffDate(pickupDate: string, daysToAdd: number): string {
  const pickup = parseISO(pickupDate);
  const result = addDays(pickup, daysToAdd);
  return format(result, "yyyy-MM-dd");
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
