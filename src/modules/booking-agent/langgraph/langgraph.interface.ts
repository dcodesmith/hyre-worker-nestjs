import type { BookingType, WhatsAppDeliveryMode } from "@prisma/client";
import type { ExtractedAiSearchParams } from "../../ai-search/ai-search.interface";
import type { VehicleSearchOption } from "../booking-agent.interface";

export type { VehicleSearchOption } from "../booking-agent.interface";

export interface BookingDraft {
  bookingType?: BookingType;
  pickupDate?: string;
  pickupTime?: string;
  dropoffDate?: string;
  durationDays?: number;
  pickupLocation?: string;
  dropoffLocation?: string;
  vehicleType?: "SEDAN" | "SUV" | "LUXURY_SEDAN" | "LUXURY_SUV" | "VAN" | "CROSSOVER";
  serviceTier?: "STANDARD" | "EXECUTIVE" | "LUXURY" | "ULTRA_LUXURY";
  color?: string;
  make?: string;
  model?: string;
  flightNumber?: string;
  notes?: string;
}

export interface UserPreferences {
  pricePreference?: "budget" | "mid" | "premium";
  rejectedVehicleIds?: string[];
  preferredBrands?: string[];
  notes?: string[];
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  interactive?: InteractiveReply;
}

export interface InteractiveReply {
  type: "button" | "list_reply";
  buttonId?: string;
  listRowId?: string;
  title?: string;
}

export type BookingStage =
  | "greeting"
  | "collecting"
  | "searching"
  | "presenting_options"
  | "awaiting_selection"
  | "confirming"
  | "creating_hold"
  | "awaiting_payment"
  | "completed"
  | "cancelled";

export type UserIntent =
  | "greeting"
  | "provide_info"
  | "update_info"
  | "select_option"
  | "confirm"
  | "reject"
  | "cancel"
  | "reset"
  | "new_booking"
  | "ask_question"
  | "request_agent"
  | "unknown";

export interface ExtractionResult {
  intent: UserIntent;
  draftPatch: Partial<BookingDraft>;
  selectionHint?: string;
  preferenceHint?: string;
  question?: string;
  confidence: number;
}

export interface QuickReplyButton {
  id: string;
  title: string;
}

export interface ListSection {
  title: string;
  rows: ListRow[];
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface InteractivePayload {
  type: "buttons" | "list";
  buttons?: QuickReplyButton[];
  listTitle?: string;
  sections?: ListSection[];
}

export interface VehicleCard {
  vehicleId: string;
  imageUrl: string | null;
  caption: string;
  buttonId: string;
  buttonTitle: string;
}

export interface AgentResponse {
  text: string;
  interactive?: InteractivePayload;
  vehicleCards?: VehicleCard[];
}

export interface LangGraphOutboxItem {
  conversationId: string;
  dedupeKey: string;
  mode: WhatsAppDeliveryMode;
  textBody?: string;
  mediaUrl?: string;
  interactive?: InteractivePayload;
  templateName?: string;
  templateVariables?: Record<string, string | number>;
}

export interface BookingAgentState {
  messages: ConversationMessage[];
  conversationId: string;
  customerId: string | null;
  inboundMessage: string;
  inboundMessageId: string;
  inboundInteractive?: InteractiveReply;
  draft: BookingDraft;
  stage: BookingStage;
  turnCount: number;
  extraction: ExtractionResult | null;
  availableOptions: VehicleSearchOption[];
  lastShownOptions: VehicleSearchOption[];
  selectedOption: VehicleSearchOption | null;
  holdId: string | null;
  holdExpiresAt: string | null;
  bookingId: string | null;
  paymentLink: string | null;
  preferences: UserPreferences;
  response: AgentResponse | null;
  outboxItems: LangGraphOutboxItem[];
  nextNode: string | null;
  error: string | null;
}

export interface LangGraphInvokeInput {
  conversationId: string;
  messageId: string;
  message: string;
  interactive?: InteractiveReply;
  customerId?: string | null;
}

export interface LangGraphInvokeResult {
  response: AgentResponse | null;
  outboxItems: LangGraphOutboxItem[];
  stage: BookingStage;
  draft: BookingDraft;
  error: string | null;
}

export type LangGraphRouteDecision = Partial<BookingAgentState> & {
  draft?: BookingDraft & { __clear?: boolean };
  preferences?: UserPreferences & { __clear?: boolean };
  nextNode?: string | null;
};

export interface WhatsAppGuestIdentity {
  guestEmail: string;
  guestName: string;
  guestPhone: string;
}

export interface BuildExtractorPromptInput {
  currentDraft: BookingDraft;
  lastShownOptions: BookingAgentState["lastShownOptions"];
  stage: BookingAgentState["stage"];
  messages: BookingAgentState["messages"];
}

export interface BuildResponderUserContextOptions {
  maxContextFieldChars: number;
  maxDraftContextChars: number;
  maxOptionContextItems: number;
}

export interface PersistedState {
  messages: ConversationMessage[];
  draft: BookingDraft;
  stage: BookingStage;
  turnCount: number;
  availableOptions: VehicleSearchOption[];
  lastShownOptions: VehicleSearchOption[];
  selectedOption: VehicleSearchOption | null;
  preferences: UserPreferences;
  holdId: string | null;
  holdExpiresAt: string | null;
  bookingId: string | null;
  updatedAt: string;
}

export function convertToExtractedParams(draft: BookingDraft): ExtractedAiSearchParams {
  return {
    color: draft.color,
    make: draft.make,
    model: draft.model,
    vehicleType: draft.vehicleType,
    serviceTier: draft.serviceTier,
    from: draft.pickupDate,
    to: draft.dropoffDate,
    bookingType: draft.bookingType,
    pickupTime: draft.pickupTime,
    pickupLocation: draft.pickupLocation,
    dropoffLocation: draft.dropoffLocation,
    flightNumber: draft.flightNumber,
  };
}

export function convertFromExtractedParams(params: ExtractedAiSearchParams): Partial<BookingDraft> {
  return {
    color: params.color,
    make: params.make,
    model: params.model,
    vehicleType: params.vehicleType,
    serviceTier: params.serviceTier,
    pickupDate: params.from,
    dropoffDate: params.to,
    bookingType: params.bookingType,
    pickupTime: params.pickupTime,
    pickupLocation: params.pickupLocation,
    dropoffLocation: params.dropoffLocation,
    flightNumber: params.flightNumber,
  };
}
