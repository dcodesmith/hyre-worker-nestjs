import type { BookingDraft } from "./langgraph.interface";

export const LANGGRAPH_DEFAULT_HISTORY_LIMIT = 10;
export const LANGGRAPH_DEFAULT_HISTORY_TTL_HOURS = 24;
export const LANGGRAPH_STATE_TTL_SECONDS = 24 * 60 * 60;

/** Structured extraction: gpt-4.1-mini follows JSON schemas more reliably than gpt-4o-mini. */
export const LANGGRAPH_EXTRACTION_MODEL = "gpt-4.1-mini";
export const LANGGRAPH_EXTRACTION_TEMPERATURE = 0;
export const LANGGRAPH_EXTRACTION_MAX_TOKENS = 500;
export const LANGGRAPH_EXTRACTION_TIMEOUT_MS = 10_000;

/** Short WhatsApp copy; keep Sonnet-class, not Opus. Override via LANGGRAPH_RESPONSE_MODEL. */
export const LANGGRAPH_RESPONSE_MODEL = "claude-sonnet-4-20250514";
export const LANGGRAPH_RESPONSE_TEMPERATURE = 0.3;
export const LANGGRAPH_RESPONSE_MAX_TOKENS = 800;
export const LANGGRAPH_RESPONSE_TIMEOUT_MS = 15_000;

export const LANGGRAPH_DRAFT_PATCH_MIN_CONFIDENCE = 0.7;

export const LANGGRAPH_ABUSE_RESPONSE =
  "I can only help with booking a Tripdly chauffeur. Please keep this chat respectful, or type *AGENT* to speak with a person.";

export const LANGGRAPH_HOLD_TTL_MINUTES = 15;

/** Shared WhatsApp Content Templates. Variables (prices, checkout token, images) come from the running environment. */
export const LANGGRAPH_VEHICLE_CARD_CONTENT_SID = "HX43448303892f9f4026057adb597e0c22";
export const LANGGRAPH_CHECKOUT_LINK_CONTENT_SID = "HX34269684dbcb609ab817c66c719eaba3";

/**
 * User-friendly message shown when an external service (OpenAI, Anthropic, etc.) is unavailable.
 * This replaces raw technical errors like "429 quota exceeded" or "500 internal server error".
 */
export const LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE =
  "This service is temporarily unavailable. Please try again in a moment or type booking online at https://www.tripdly.com.";

export const REQUIRED_SEARCH_FIELDS: (keyof BookingDraft)[] = [
  "pickupDate",
  "bookingType",
  "pickupLocation",
  "pickupTime",
  "dropoffDate",
  "dropoffLocation",
];

export const LANGGRAPH_NODE_NAMES = {
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
