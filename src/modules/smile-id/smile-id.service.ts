import { createHmac, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { type AxiosInstance } from "axios";
import type { EnvConfig } from "../../config/env.config";
import { HttpClientService } from "../http-client/http-client.service";
import type {
  CompareSelfieToImageInput,
  CompareSelfieToImageResult,
  SmileIdErrorKind,
} from "./smile-id.interface";
import {
  smileIdAcceptedResponseSchema,
  smileIdJobStatusSchema,
  smileIdTokenResponseSchema,
} from "./smile-id.schema";

export class SmileIdError extends Error {
  constructor(readonly kind: SmileIdErrorKind) {
    super(kind);
  }
}

const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

@Injectable()
export class SmileIdService {
  private readonly client: AxiosInstance;
  private readonly partnerId: string;
  private readonly apiKey: string;
  private readonly callbackUrl: string | undefined;

  constructor(configService: ConfigService<EnvConfig, true>, httpClientService: HttpClientService) {
    this.partnerId = configService.get("SMILE_ID_PARTNER_ID", { infer: true });
    this.apiKey = configService.get("SMILE_ID_API_KEY", { infer: true });
    this.callbackUrl = configService.get("SMILE_ID_CALLBACK_URL", { infer: true });
    this.client = httpClientService.createClient({
      serviceName: "Smile ID",
      baseURL:
        configService.get("SMILE_ID_BASE_URL", { infer: true }) ??
        "https://testapi.smileidentity.com",
      timeout: 30_000,
    });
  }

  async compareSelfieToImage(
    input: CompareSelfieToImageInput,
  ): Promise<CompareSelfieToImageResult> {
    const userDetails = this.userDetails(input.user);
    const token = await this.token();
    const body = new FormData();
    body.append("selfie_image", this.jpeg(input.selfie, "selfie.jpg"));
    body.append("comparison_image", this.jpeg(input.comparisonImage, "comparison.jpg"));
    body.append("comparison_image_type", input.comparisonImageType);
    body.append(
      "consent",
      JSON.stringify({
        granted: true,
        granted_at: input.consent.grantedAt.toISOString(),
        notice_language: input.consent.noticeLanguage.toUpperCase(),
        notice_privacy_policy_url: input.consent.privacyPolicyUrl,
      }),
    );
    body.append("user_details", JSON.stringify(userDetails));
    const callbackUrl = input.callbackUrl ?? this.callbackUrl;
    if (callbackUrl) body.append("callback_url", callbackUrl);
    if (input.partnerParams) body.append("partner_params", JSON.stringify(input.partnerParams));

    try {
      const { data } = await this.client.post("/v3/compare", body, {
        headers: this.multipartHeaders({ "SmileID-Token": token }),
      });
      const accepted = smileIdAcceptedResponseSchema.safeParse(data);
      if (!accepted.success) throw new SmileIdError("INVALID_RESPONSE");
      return { jobId: accepted.data.job_id, createdAt: accepted.data.created_at ?? null };
    } catch (error) {
      if (error instanceof SmileIdError) throw error;
      throw this.mapHttpError(error);
    }
  }

  async comparisonStatus(
    jobId: string,
  ): Promise<"clear" | "block" | "attention" | "error" | "processing" | "not_found"> {
    const token = await this.token();
    try {
      const { data, status } = await this.client.get(`/v3/status/${encodeURIComponent(jobId)}`, {
        headers: { "SmileID-Token": token },
        validateStatus: (httpStatus) =>
          httpStatus === 200 || httpStatus === 202 || httpStatus === 404,
      });
      if (status === 404) return "not_found";
      const parsed = smileIdJobStatusSchema.safeParse(data);
      if (!parsed.success || parsed.data.job_id !== jobId) {
        throw new SmileIdError("INVALID_RESPONSE");
      }
      return parsed.data.status;
    } catch (error) {
      if (error instanceof SmileIdError) throw error;
      throw this.mapHttpError(error);
    }
  }

  webhookAuthentic(timestamp: string | undefined, signature: string | undefined): boolean {
    if (!timestamp || !signature) return false;
    const sentAt = Date.parse(timestamp);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > WEBHOOK_MAX_AGE_MS)
      return false;
    const expected = createHmac("sha256", this.apiKey)
      .update(`${timestamp}${this.partnerId}sid_request`)
      .digest("base64");
    const received = Buffer.from(signature);
    const computed = Buffer.from(expected);
    return received.length === computed.length && timingSafeEqual(received, computed);
  }

  private async token(): Promise<string> {
    const body = new FormData();
    body.append("product", "smart_selfie_compare");
    try {
      const { data } = await this.client.post("/v3/token", body, {
        headers: this.multipartHeaders({
          "smileid-partner-id": this.partnerId,
          "smileid-api-key": this.apiKey,
        }),
      });
      const parsed = smileIdTokenResponseSchema.safeParse(data);
      if (!parsed.success) throw new SmileIdError("INVALID_RESPONSE");
      return parsed.data.token;
    } catch (error) {
      if (error instanceof SmileIdError) throw error;
      throw this.mapHttpError(error);
    }
  }

  private userDetails(user: CompareSelfieToImageInput["user"]) {
    const email = user.email?.trim();
    const phoneNumber = user.phoneNumber?.trim();
    if (!email && !phoneNumber) throw new SmileIdError("INVALID_RESPONSE");
    return {
      given_names: user.givenNames.trim(),
      last_name: user.lastName.trim(),
      ...(email ? { email } : {}),
      ...(phoneNumber ? { phone_number: phoneNumber } : {}),
    };
  }

  private jpeg(contents: Buffer, filename: string) {
    return new File([new Uint8Array(contents)], filename, { type: "image/jpeg" });
  }

  private multipartHeaders(headers: Record<string, string>) {
    return { ...headers, "Content-Type": undefined };
  }

  private mapHttpError(error: unknown): SmileIdError {
    if (axios.isAxiosError(error) && error.response?.status === 400) {
      return new SmileIdError("INVALID_RESPONSE");
    }
    return new SmileIdError("UNAVAILABLE");
  }
}
