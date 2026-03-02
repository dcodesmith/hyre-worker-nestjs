import { REQUIRED_SEARCH_FIELDS } from "./langgraph/langgraph.const";
import { BookingDraft } from "./langgraph/langgraph.interface";

export function getMissingRequiredFields(draft: BookingDraft): string[] {
  return REQUIRED_SEARCH_FIELDS.filter((field) => !draft[field]);
}
