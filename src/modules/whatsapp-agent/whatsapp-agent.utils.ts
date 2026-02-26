import { createHash } from "node:crypto";
import type { TwilioInboundWebhookPayload, WhatsAppMediaPayload } from "./whatsapp-agent.interface";

function toE164(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("+")) {
    return `+${trimmed.slice(1).replaceAll(/[^\d]/g, "")}`;
  }
  return `+${trimmed.replaceAll(/[^\d]/g, "")}`;
}

export function normalizeTwilioWhatsAppPhone(phone: string | undefined): string | null {
  if (!phone) {
    return null;
  }

  const normalized = phone.replace(/^whatsapp:/i, "").trim();
  if (!normalized) {
    return null;
  }

  const e164 = toE164(normalized);
  // E.164 allows up to 15 digits after plus; enforce sensible minimum.
  if (!/^\+\d{8,15}$/.test(e164)) {
    return null;
  }

  return e164;
}

export function extractInboundMedia(payload: TwilioInboundWebhookPayload): WhatsAppMediaPayload[] {
  const countRaw = payload.NumMedia ?? "0";
  const count = Number.parseInt(countRaw, 10);
  if (!Number.isFinite(count) || count <= 0) {
    return [];
  }

  const media: WhatsAppMediaPayload[] = [];
  for (let index = 0; index < count; index += 1) {
    const url = payload[`MediaUrl${index}`];
    if (!url) {
      continue;
    }
    media.push({
      url,
      contentType: payload[`MediaContentType${index}`],
    });
  }

  return media;
}

export function deriveMessageKind(payload: TwilioInboundWebhookPayload) {
  const body = payload.Body?.trim();
  const media = extractInboundMedia(payload);
  const firstContentType = media[0]?.contentType?.toLowerCase() ?? "";

  if (media.length > 0) {
    if (firstContentType.startsWith("image/")) return "IMAGE" as const;
    if (firstContentType.startsWith("audio/")) return "AUDIO" as const;
    if (firstContentType.includes("location")) return "LOCATION" as const;
    return "DOCUMENT" as const;
  }

  if (body) {
    return "TEXT" as const;
  }

  return "UNKNOWN" as const;
}

export function buildInboundDedupeKey(payload: TwilioInboundWebhookPayload): string {
  if (payload.MessageSid) {
    return `twilio:inbound:sid:${payload.MessageSid}`;
  }

  const fallbackData = JSON.stringify(payload);
  const digest = createHash("sha256").update(fallbackData).digest("hex");
  return `twilio:inbound:hash:${digest}`;
}

export function isInboundCustomerMessage(payload: TwilioInboundWebhookPayload): boolean {
  if (payload.MessageStatus) {
    return false;
  }

  const fromPhone = normalizeTwilioWhatsAppPhone(payload.From);
  if (!fromPhone) {
    return false;
  }

  return true;
}
