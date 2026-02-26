import { describe, expect, it } from "vitest";
import {
  buildInboundDedupeKey,
  deriveMessageKind,
  extractInboundMedia,
  isInboundCustomerMessage,
  normalizeTwilioWhatsAppPhone,
} from "./whatsapp-agent.utils";

describe("whatsapp-agent utils", () => {
  it("normalizes Twilio WhatsApp address into E.164", () => {
    expect(normalizeTwilioWhatsAppPhone("whatsapp:+2348012345678")).toBe("+2348012345678");
    expect(normalizeTwilioWhatsAppPhone(" +1 (555) 123-4567 ")).toBe("+15551234567");
  });

  it("returns null for invalid phone values", () => {
    expect(normalizeTwilioWhatsAppPhone(undefined)).toBeNull();
    expect(normalizeTwilioWhatsAppPhone("whatsapp:abc")).toBeNull();
  });

  it("extracts media payloads from Twilio-style indexed keys", () => {
    const media = extractInboundMedia({
      NumMedia: "2",
      MediaUrl0: "https://example.com/a.jpg",
      MediaContentType0: "image/jpeg",
      MediaUrl1: "https://example.com/b.ogg",
      MediaContentType1: "audio/ogg",
    });

    expect(media).toEqual([
      { url: "https://example.com/a.jpg", contentType: "image/jpeg" },
      { url: "https://example.com/b.ogg", contentType: "audio/ogg" },
    ]);
  });

  it("derives message kind from media and text", () => {
    expect(
      deriveMessageKind({
        NumMedia: "1",
        MediaUrl0: "https://example.com/a.ogg",
        MediaContentType0: "audio/ogg",
      }),
    ).toBe("AUDIO");
    expect(deriveMessageKind({ Body: "hello", NumMedia: "0" })).toBe("TEXT");
    expect(deriveMessageKind({ NumMedia: "0" })).toBe("UNKNOWN");
  });

  it("uses message sid for deterministic inbound dedupe key", () => {
    expect(buildInboundDedupeKey({ MessageSid: "SM123" })).toBe("twilio:inbound:sid:SM123");
  });

  it("uses hash fallback for deterministic inbound dedupe key when no MessageSid", () => {
    const key = buildInboundDedupeKey({
      From: "whatsapp:+2348012345678",
      Body: "need a white suv tomorrow",
      NumMedia: "0",
    });
    expect(key).toMatch(/^twilio:inbound:hash:[a-f0-9]{64}$/);
  });

  it("rejects status callbacks as inbound customer messages", () => {
    expect(
      isInboundCustomerMessage({
        From: "whatsapp:+2348012345678",
        MessageStatus: "delivered",
      }),
    ).toBe(false);
  });
});
