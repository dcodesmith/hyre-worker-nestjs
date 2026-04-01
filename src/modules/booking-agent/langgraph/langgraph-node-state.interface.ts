import type { BookingAgentState, BookingDraft, UserPreferences } from "./langgraph.interface";

export type LangGraphNodeState = BookingAgentState;

export type LangGraphNodeResult = Partial<BookingAgentState> & {
  draft?: BookingDraft & { __clear?: boolean };
  preferences?: UserPreferences & { __clear?: boolean };
};
