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
  name: string;
  color: string | null;
  imageUrl: string | null;
  rates: {
    day: number;
    night: number | null;
    fullDay: number | null;
    airportPickup: number | null;
  };
}

export interface VehicleSearchToolResult {
  interpretation: string;
  extracted: ExtractedAiSearchParams;
  options: VehicleSearchOption[];
}
