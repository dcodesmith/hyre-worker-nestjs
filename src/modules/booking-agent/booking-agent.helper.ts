import { REQUIRED_SEARCH_FIELDS } from "./conversation/conversation.const";
import { BookingDraft } from "./conversation/conversation.interface";

export function getMissingRequiredFields(draft: BookingDraft): string[] {
  return REQUIRED_SEARCH_FIELDS.filter((field) => !draft[field]);
}
