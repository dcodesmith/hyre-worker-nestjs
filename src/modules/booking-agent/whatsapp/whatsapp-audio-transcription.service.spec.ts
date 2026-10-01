import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { OPENAI_SDK_CLIENT } from "../../openai-sdk/openai-sdk.tokens";
import { WHATSAPP_AUDIO_MAX_BYTES } from "../booking-agent.const";
import { WhatsAppAudioTranscriptionService } from "./whatsapp-audio-transcription.service";

type TranscriptionServiceInternals = {
  downloadMediaBinary: (mediaUrl: string) => Promise<Uint8Array>;
  transcribeAudioBinary: (
    audioBytes: Uint8Array,
    mediaContentType?: string | null,
  ) => Promise<string>;
};

describe("WhatsAppAudioTranscriptionService", () => {
  let moduleRef: TestingModule;
  let service: WhatsAppAudioTranscriptionService;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppAudioTranscriptionService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => {
              if (key === "TWILIO_ACCOUNT_SID") return "test-account-sid";
              if (key === "TWILIO_AUTH_TOKEN") return "test-auth-token";
              return undefined;
            }),
          },
        },
        {
          provide: OPENAI_SDK_CLIENT,
          useValue: {
            audio: {
              transcriptions: {
                create: vi.fn(),
              },
            },
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = moduleRef.get(WhatsAppAudioTranscriptionService);
  });

  it("returns transcript for audio media", async () => {
    vi.spyOn(
      service as unknown as TranscriptionServiceInternals,
      "downloadMediaBinary",
    ).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(
      service as unknown as TranscriptionServiceInternals,
      "transcribeAudioBinary",
    ).mockResolvedValue("  I need a Camry for tomorrow  ");

    await expect(
      service.transcribeInboundAudio({
        mediaUrl: "https://api.twilio.com/media/123",
        mediaContentType: "audio/ogg",
        traceId: "conv-1:msg-1",
      }),
    ).resolves.toBe("I need a Camry for tomorrow");
  });

  it("returns null for non-audio media", async () => {
    const downloadSpy = vi.spyOn(
      service as unknown as TranscriptionServiceInternals,
      "downloadMediaBinary",
    );

    await expect(
      service.transcribeInboundAudio({
        mediaUrl: "https://api.twilio.com/media/123",
        mediaContentType: "image/jpeg",
        traceId: "conv-1:msg-1",
      }),
    ).resolves.toBeNull();

    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it("returns null when media URL is missing", async () => {
    await expect(
      service.transcribeInboundAudio({
        mediaUrl: null,
        mediaContentType: "audio/ogg",
        traceId: "conv-1:msg-1",
      }),
    ).resolves.toBeNull();
  });

  it("rejects media URL with non-Twilio domain", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const transcribeSpy = vi.spyOn(
      service as unknown as TranscriptionServiceInternals,
      "transcribeAudioBinary",
    );

    await expect(
      service.transcribeInboundAudio({
        mediaUrl: "https://example.com/media/123",
        mediaContentType: "audio/ogg",
        traceId: "conv-1:msg-1",
      }),
    ).rejects.toThrow("Invalid WhatsApp media URL domain");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(transcribeSpy).not.toHaveBeenCalled();
  });

  it("rejects media URL with non-HTTPS protocol", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      service.transcribeInboundAudio({
        mediaUrl: "http://api.twilio.com/media/123",
        mediaContentType: "audio/ogg",
        traceId: "conv-1:msg-1",
      }),
    ).rejects.toThrow("Invalid WhatsApp media URL protocol");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects audio when content-length exceeds the byte cap", async () => {
    const read = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-length" ? String(WHATSAPP_AUDIO_MAX_BYTES + 1) : null,
      },
      body: {
        getReader: () => ({ read, cancel: vi.fn() }),
      },
    } as unknown as Response);
    const transcribeSpy = vi.spyOn(
      service as unknown as TranscriptionServiceInternals,
      "transcribeAudioBinary",
    );

    await expect(
      service.transcribeInboundAudio({
        mediaUrl: "https://api.twilio.com/media/123",
        mediaContentType: "audio/ogg",
        traceId: "conv-1:msg-1",
      }),
    ).rejects.toThrow(`WhatsApp audio exceeds the ${WHATSAPP_AUDIO_MAX_BYTES} byte limit`);

    expect(read).not.toHaveBeenCalled();
    expect(transcribeSpy).not.toHaveBeenCalled();
  });

  it("cancels the media stream when the downloaded audio exceeds the byte cap", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({
            done: false,
            value: new Uint8Array(WHATSAPP_AUDIO_MAX_BYTES + 1),
          }),
          cancel,
        }),
      },
    } as unknown as Response);
    const transcribeSpy = vi.spyOn(
      service as unknown as TranscriptionServiceInternals,
      "transcribeAudioBinary",
    );

    await expect(
      service.transcribeInboundAudio({
        mediaUrl: "https://media.twiliocdn.com/audio/123",
        mediaContentType: "audio/ogg",
        traceId: "conv-1:msg-1",
      }),
    ).rejects.toThrow(`WhatsApp audio exceeds the ${WHATSAPP_AUDIO_MAX_BYTES} byte limit`);

    expect(cancel).toHaveBeenCalledOnce();
    expect(transcribeSpy).not.toHaveBeenCalled();
  });
});
