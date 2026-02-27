import type { WhatsAppDeliveryMode, WhatsAppMessageKind } from "@prisma/client";
import { ExtractedAiSearchParams } from "../ai-search/ai-search.interface";

export interface TwilioInboundWebhookPayload {
  MessageSid?: string;
  AccountSid?: string;
  From?: string;
  To?: string;
  WaId?: string;
  ProfileName?: string;
  Body?: string;
  NumMedia?: string;
  MessageStatus?: string;
  SmsStatus?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
  [key: string]: string | undefined;
}

export interface WhatsAppMediaPayload {
  url: string;
  contentType?: string;
}

export interface ProcessWhatsAppInboundJobData {
  conversationId: string;
  messageId: string;
  dedupeKey: string;
}

export interface ProcessWhatsAppOutboxJobData {
  outboxId: string;
}

export interface CreateOutboxInput {
  conversationId: string;
  dedupeKey: string;
  mode: WhatsAppDeliveryMode;
  textBody?: string;
  mediaUrl?: string;
  templateName?: string;
  templateVariables?: Record<string, string | number>;
}

export interface OrchestratorResult {
  enqueueOutbox: CreateOutboxInput[];
  markAsHandoff?: {
    reason: string;
  };
}

export interface InboundMessageContext {
  messageId: string;
  conversationId: string;
  body?: string;
  kind: WhatsAppMessageKind;
}

export interface VehicleSearchOption {
  id: string;
  make: string;
  model: string;
  name: string;
  color: string | null;
  vehicleType: string;
  serviceTier: string;
  imageUrl: string | null;
  rates: {
    day: number;
    night: number | null;
    fullDay: number | null;
    airportPickup: number | null;
  };
  estimatedTotalInclVat?: number;
  estimatedSubtotal?: number;
  estimatedVatAmount?: number;
  estimateBasis?: string;
}

export type VehicleSearchAlternativeReason =
  | "SAME_MODEL_DIFFERENT_COLOR"
  | "SAME_COLOR_SIMILAR_CLASS"
  | "SIMILAR_CLASS"
  | "SIMILAR_PRICE_RANGE"
  | "CLOSEST_AVAILABLE";

export interface VehicleSearchAlternative extends VehicleSearchOption {
  reason: VehicleSearchAlternativeReason;
  score: number;
}

export type VehicleSearchPreconditionField =
  | "from"
  | "to"
  | "bookingType"
  | "pickupTime"
  | "pickupLocation"
  | "dropoffLocation"
  | "flightNumber";

export interface VehicleSearchPrecondition {
  missingField: VehicleSearchPreconditionField;
  prompt: string;
}

export interface VehicleSearchToolResult {
  interpretation: string;
  extracted: ExtractedAiSearchParams;
  exactMatches: VehicleSearchOption[];
  alternatives: VehicleSearchAlternative[];
  precondition: VehicleSearchPrecondition | null;
  shouldClarifyBookingType: boolean;
}

export type VehicleSearchMessageResult =
  | {
      kind: "no_intent";
    }
  | {
      kind: "error";
      error: string;
    }
  | {
      kind: "ask_precondition";
      result: VehicleSearchToolResult;
    }
  | {
      kind: "ask_booking_clarification";
      result: VehicleSearchToolResult;
    }
  | {
      kind: "show_options";
      result: VehicleSearchToolResult;
    }
  | {
      kind: "no_options";
      result: VehicleSearchToolResult;
    };

export type SearchQuestionType = "precondition" | "booking_clarification";

export interface SearchDialogState {
  bookingTypeConfirmed: boolean;
  lastAskedQuestionType: SearchQuestionType | null;
  lastAskedAt: string | null;
}

export interface SearchSlotPayload {
  extracted: ExtractedAiSearchParams;
  dialogState?: SearchDialogState;
  updatedAt: string;
}

export interface SearchSlotSnapshot {
  extracted: ExtractedAiSearchParams | null;
  dialogState: SearchDialogState;
  updatedAt: string | null;
  raw: string | null;
}

export interface SearchSlotMergeResult {
  extracted: ExtractedAiSearchParams;
  dialogState: SearchDialogState;
}
