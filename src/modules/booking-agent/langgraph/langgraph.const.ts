import type { BookingDraft } from "./langgraph.interface";

export const LANGGRAPH_DEFAULT_HISTORY_LIMIT = 10;
export const LANGGRAPH_DEFAULT_HISTORY_TTL_HOURS = 24;
export const LANGGRAPH_STATE_TTL_SECONDS = 24 * 60 * 60;

export const LANGGRAPH_EXTRACTION_MODEL = "gpt-4o-mini";
export const LANGGRAPH_EXTRACTION_TEMPERATURE = 0;
export const LANGGRAPH_EXTRACTION_MAX_TOKENS = 500;
export const LANGGRAPH_EXTRACTION_TIMEOUT_MS = 10_000;

export const LANGGRAPH_RESPONSE_MODEL = "claude-sonnet-4-20250514";
export const LANGGRAPH_RESPONSE_TEMPERATURE = 0.3;
export const LANGGRAPH_RESPONSE_MAX_TOKENS = 800;
export const LANGGRAPH_RESPONSE_TIMEOUT_MS = 15_000;

export const LANGGRAPH_HOLD_TTL_MINUTES = 15;

// Twilio Content Template for vehicle selection cards
// Template variables: {{1}}=title, {{2}}=body, {{3}}=mediaUrl, {{4}}=buttonText, {{5}}=vehicleId
export const VEHICLE_CARD_CONTENT_SID = "HX43448303892f9f4026057adb597e0c22";

// Twilio Content Template for checkout link
// Template variables: {{1}}=body text, {{2}}=checkout token segment from /pay/{token}
export const CHECKOUT_LINK_CONTENT_SID = "HX34269684dbcb609ab817c66c719eaba3";

export const REQUIRED_SEARCH_FIELDS: (keyof BookingDraft)[] = [
  "pickupDate",
  "bookingType",
  "pickupLocation",
  "pickupTime",
  "dropoffDate",
  "dropoffLocation",
];

export const LANGGRAPH_NODE_NAMES = {
  INGEST: "ingest",
  EXTRACT: "extract",
  MERGE: "merge",
  ROUTE: "route",
  SEARCH: "search",
  CREATE_BOOKING: "create_booking",
  RESPOND: "respond",
  HANDOFF: "handoff",
} as const;

export const LANGGRAPH_OUTBOUND_MODE = {
  FREE_FORM: "FREE_FORM",
  TEMPLATE: "TEMPLATE",
} as const;

export const LANGGRAPH_BUTTON_ID = {
  CONFIRM: "confirm",
  YES: "yes",
  NO: "no",
  REJECT: "reject",
  SHOW_OTHERS: "show_others",
  MORE_OPTIONS: "more_options",
  CANCEL: "cancel",
  AGENT: "agent",
  DAY: "day",
  NIGHT: "night",
  FULL_DAY: "fullday",
  RETRY_BOOKING: "retry_booking",
} as const;

export const LANGGRAPH_REDIS_KEY_PREFIX = "langgraph:booking-agent";

export function buildLangGraphStateKey(conversationId: string): string {
  return `${LANGGRAPH_REDIS_KEY_PREFIX}:state:${conversationId}`;
}

export function buildLangGraphCheckpointKey(conversationId: string): string {
  return `${LANGGRAPH_REDIS_KEY_PREFIX}:checkpoint:${conversationId}`;
}
