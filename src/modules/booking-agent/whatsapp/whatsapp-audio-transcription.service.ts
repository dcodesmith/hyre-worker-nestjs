import { Buffer } from "node:buffer";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { toFile } from "openai/uploads";
import type { EnvConfig } from "../../../config/env.config";
import { OPENAI_SDK_CLIENT, type OpenAiSdkClient } from "../../openai-sdk/openai-sdk.tokens";

@Injectable()
export class WhatsAppAudioTranscriptionService {
  private readonly logger = new Logger(WhatsAppAudioTranscriptionService.name);
  private readonly twilioAccountSid: string;
  private readonly twilioAuthToken: string;

  constructor(
    @Inject(OPENAI_SDK_CLIENT) private readonly openaiClient: OpenAiSdkClient,
    private readonly configService: ConfigService<EnvConfig>,
  ) {
    this.twilioAccountSid = this.configService.get("TWILIO_ACCOUNT_SID", { infer: true });
    this.twilioAuthToken = this.configService.get("TWILIO_AUTH_TOKEN", { infer: true });
  }

  async transcribeInboundAudio(input: {
    mediaUrl?: string | null;
    mediaContentType?: string | null;
    traceId: string;
  }): Promise<string | null> {
    const { mediaUrl, mediaContentType, traceId } = input;
    if (!mediaUrl) {
      return null;
    }
    if (!this.isAudioContentType(mediaContentType)) {
      return null;
    }

    const audioBytes = await this.downloadMediaBinary(mediaUrl);
    const transcript = await this.transcribeAudioBinary(audioBytes, mediaContentType);
    const normalizedTranscript = transcript.trim();

    if (!normalizedTranscript) {
      this.logger.warn("Audio transcription returned empty text", { traceId });
      return null;
    }

    return normalizedTranscript;
  }

  private isAudioContentType(contentType?: string | null): boolean {
    if (!contentType) {
      return true;
    }
    return contentType.toLowerCase().startsWith("audio/");
  }

  private async downloadMediaBinary(mediaUrl: string): Promise<Uint8Array> {
    const basicAuth = Buffer.from(`${this.twilioAccountSid}:${this.twilioAuthToken}`).toString(
      "base64",
    );
    const response = await fetch(mediaUrl, {
      headers: {
        Authorization: `Basic ${basicAuth}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch WhatsApp media (${response.status})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  private async transcribeAudioBinary(
    audioBytes: Uint8Array,
    mediaContentType: string | null = "audio/ogg",
  ): Promise<string> {
    const contentType = mediaContentType;
    const extension = this.resolveFileExtension(contentType);
    const file = await toFile(Buffer.from(audioBytes), `voice-note${extension}`, {
      type: contentType,
    });

    const transcription = await this.openaiClient.audio.transcriptions.create({
      file,
      model: "gpt-4o-mini-transcribe",
      response_format: "text",
    });

    if (typeof transcription === "string") {
      return transcription;
    }

    return "";
  }

  private resolveFileExtension(contentType: string): string {
    const normalized = contentType.toLowerCase();
    if (normalized.includes("mpeg") || normalized.includes("mp3")) return ".mp3";
    if (normalized.includes("wav")) return ".wav";
    if (normalized.includes("webm")) return ".webm";
    if (normalized.includes("mp4") || normalized.includes("m4a")) return ".m4a";
    return ".ogg";
  }
}
