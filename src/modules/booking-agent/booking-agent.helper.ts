import { REQUIRED_SEARCH_FIELDS } from "./conversation/conversation.const";
import type { BookingDraft } from "./conversation/conversation.interface";

export function getMissingRequiredFields(draft: BookingDraft): string[] {
  const requiredFields =
    draft.bookingType === "AIRPORT_PICKUP"
      ? REQUIRED_SEARCH_FIELDS.AIRPORT_PICKUP
      : REQUIRED_SEARCH_FIELDS.DEFAULT;
  return requiredFields.filter((field) => !draft[field]);
}
