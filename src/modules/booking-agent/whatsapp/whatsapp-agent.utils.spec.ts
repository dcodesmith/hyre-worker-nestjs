import { describe, expect, it } from "vitest";
import {
  buildInboundDedupeKey,
  deriveMessageKind,
  extractInboundMedia,
  isInboundCustomerMessage,
  normalizeTwilioWhatsAppPhone,
  parseInteractiveReply,
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

  describe("parseInteractiveReply", () => {
    it("returns null for null/undefined payload", () => {
      expect(parseInteractiveReply(null)).toBeNull();
      expect(parseInteractiveReply(undefined)).toBeNull();
    });

    it("returns null for non-object payload", () => {
      expect(parseInteractiveReply("string")).toBeNull();
      expect(parseInteractiveReply(123)).toBeNull();
      expect(parseInteractiveReply(true)).toBeNull();
    });

    it("returns null for payload without interactive data", () => {
      expect(parseInteractiveReply({})).toBeNull();
      expect(parseInteractiveReply({ Body: "hello" })).toBeNull();
      expect(parseInteractiveReply({ MessageSid: "SM123" })).toBeNull();
    });

    it("parses button reply with ButtonPayload and ButtonText", () => {
      const result = parseInteractiveReply({
        ButtonPayload: "vehicle:abc123",
        ButtonText: "Toyota Camry",
      });

      expect(result).toEqual({
        type: "button",
        buttonId: "vehicle:abc123",
        title: "Toyota Camry",
      });
    });

    it("parses button reply with only ButtonPayload", () => {
      const result = parseInteractiveReply({
        ButtonPayload: "confirm:yes",
      });

      expect(result).toEqual({
        type: "button",
        buttonId: "confirm:yes",
        title: undefined,
      });
    });

    it("parses button reply with only ButtonText", () => {
      const result = parseInteractiveReply({
        ButtonText: "Yes, confirm",
      });

      expect(result).toEqual({
        type: "button",
        buttonId: "",
        title: "Yes, confirm",
      });
    });

    it("parses list reply with ListId and ListTitle", () => {
      const result = parseInteractiveReply({
        ListId: "option-1",
        ListTitle: "First Option",
      });

      expect(result).toEqual({
        type: "list_reply",
        listRowId: "option-1",
        title: "First Option",
      });
    });

    it("parses list reply with only ListId", () => {
      const result = parseInteractiveReply({
        ListId: "option-2",
      });

      expect(result).toEqual({
        type: "list_reply",
        listRowId: "option-2",
        title: undefined,
      });
    });

    it("parses list reply with only ListTitle", () => {
      const result = parseInteractiveReply({
        ListTitle: "Second Option",
      });

      expect(result).toEqual({
        type: "list_reply",
        listRowId: undefined,
        title: "Second Option",
      });
    });

    it("prioritizes button reply over list reply when both present", () => {
      const result = parseInteractiveReply({
        ButtonPayload: "btn-123",
        ButtonText: "Button",
        ListId: "list-456",
        ListTitle: "List Item",
      });

      expect(result).toEqual({
        type: "button",
        buttonId: "btn-123",
        title: "Button",
      });
    });
  });
});
