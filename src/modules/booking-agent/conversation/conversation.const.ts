import { getEmailPublicEnv } from "../../../email-public-env";
import type { BookingDraft } from "./conversation.interface";

export const BOOKING_AGENT_DEFAULT_HISTORY_LIMIT = 10;
export const BOOKING_AGENT_STATE_TTL_SECONDS = 24 * 60 * 60;

export const BOOKING_AGENT_EXTRACTION_MODEL = "gpt-4o-mini";

export const BOOKING_AGENT_RESPONSE_MODEL = "claude-sonnet-5-5";
export const BOOKING_AGENT_RESPONSE_MAX_TOKENS = 4096;
export const BOOKING_AGENT_MODEL_TIMEOUT_MS = 10_000;
export const BOOKING_AGENT_MODEL_MAX_RETRIES = 1;
export const BOOKING_AGENT_ANY_VEHICLE_PREFERENCE = "ANY";
const BOOKING_AGENT_SERVICE_UNAVAILABLE_PREFIX = "This service is temporarily unavailable.";

/**
 * User-friendly message shown when an external service (OpenAI, Anthropic, etc.) is unavailable.
 * This replaces raw technical errors like "429 quota exceeded" or "500 internal server error".
 */
export function getBookingAgentServiceUnavailableMessage(): string {
  return `${BOOKING_AGENT_SERVICE_UNAVAILABLE_PREFIX} Please try again in a moment or type booking online at ${getEmailPublicEnv().websiteUrl}.`;
}

export function isBookingAgentServiceUnavailableMessage(value: string | null): boolean {
  return value?.startsWith(BOOKING_AGENT_SERVICE_UNAVAILABLE_PREFIX) ?? false;
}

// Twilio Content Template for vehicle selection cards
// Template variables: {{1}}=WhatsApp-visible title with price, {{2}}=RCS-only body,
// {{3}}=mediaUrl, {{4}}=buttonText, {{5}}=vehicleId
export const VEHICLE_CARD_CONTENT_SID = "HX43448303892f9f4026057adb597e0c22";

// Twilio Content Template for confirmation quick replies (no variables)
export const BOOKING_CONFIRMATION_CONTENT_SID = "HX49f0f60de446a9b6bd2425dffab6303c";

// Twilio Content Template for checkout link
// Template variables: {{1}}=body text, {{2}}=checkout token segment from /pay/{token}
export const CHECKOUT_LINK_CONTENT_SID = "HX34269684dbcb609ab817c66c719eaba3";

export const REQUIRED_SEARCH_FIELDS = {
  DEFAULT: [
    "pickupDate",
    "bookingType",
    "vehicleType",
    "pickupLocation",
    "pickupTime",
    "dropoffDate",
    "dropoffLocation",
  ],
  AIRPORT_PICKUP: ["pickupDate", "bookingType", "flightNumber", "vehicleType", "dropoffLocation"],
} as const satisfies Record<"DEFAULT" | "AIRPORT_PICKUP", readonly (keyof BookingDraft)[]>;

export const BOOKING_AGENT_ACTIONS = {
  SEARCH: "search",
  PREPARE_QUOTE: "prepare_quote",
  CREATE_BOOKING: "create_booking",
  RESPOND: "respond",
  HANDOFF: "handoff",
} as const;

export const BOOKING_AGENT_OUTBOUND_MODE = {
  FREE_FORM: "FREE_FORM",
  TEMPLATE: "TEMPLATE",
} as const;

export const BOOKING_AGENT_BUTTON_ID = {
  CONFIRM: "confirm",
  YES: "yes",
  NO: "no",
  REJECT: "reject",
  SHOW_OTHERS: "show_others",
  CHANGE_DETAILS: "change_details",
  MORE_OPTIONS: "more_options",
  CANCEL: "cancel",
  AGENT: "agent",
  DAY: "day",
  NIGHT: "night",
  FULL_DAY: "fullday",
  RETRY_BOOKING: "retry_booking",
  ADDON_SKIP_ALL: "addon_skip_all",
  FUEL_APPLY: "fuel_apply",
  FUEL_SKIP: "fuel_skip",
  CREDITS_APPLY: "credits_apply",
  CREDITS_SKIP: "credits_skip",
} as const;

export const BOOKING_AGENT_REDIS_KEY_PREFIX = "booking-agent";

export function buildBookingAgentStateKey(conversationId: string): string {
  return `${BOOKING_AGENT_REDIS_KEY_PREFIX}:state:${conversationId}`;
}
