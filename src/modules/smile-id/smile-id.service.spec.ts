import { createHmac } from "node:crypto";
import { HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAxiosErrorWithResponse,
  createMockAxiosInstance,
  createMockHttpClientService,
} from "../http-client/http-client.fixtures";
import { HttpClientService } from "../http-client/http-client.service";
import { SmileIdError, SmileIdService } from "./smile-id.service";

const input = {
  selfie: Buffer.from("selfie"),
  comparisonImage: Buffer.from("nin-portrait"),
  comparisonImageType: "PORTRAIT" as const,
  consent: {
    grantedAt: new Date("2026-09-25T12:00:00.000Z"),
    noticeLanguage: "en",
    privacyPolicyUrl: "https://tripdly.com/privacy",
  },
  user: {
    givenNames: "Oyewole",
    lastName: "Balogun",
    email: "driver@example.com",
  },
};

describe("SmileIdService", () => {
  let service: SmileIdService;
  let mockAxiosInstance: ReturnType<typeof createMockAxiosInstance>;

  beforeEach(async () => {
    mockAxiosInstance = createMockAxiosInstance();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmileIdService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => {
              const config: Record<string, string> = {
                SMILE_ID_PARTNER_ID: "123",
                SMILE_ID_API_KEY: "smile-key",
                SMILE_ID_BASE_URL: "https://testapi.smileidentity.com",
                SMILE_ID_CALLBACK_URL: "https://hyre-worker-nestjs.fly.dev/api/smile-id/compare",
              };
              return config[key];
            }),
          },
        },
        { provide: HttpClientService, useValue: createMockHttpClientService(mockAxiosInstance) },
      ],
    }).compile();

    service = module.get(SmileIdService);
  });

  it("submits the camera selfie and stored portrait for comparison", async () => {
    mockAxiosInstance.post
      .mockResolvedValueOnce({ data: { token: "smile-token" } })
      .mockResolvedValueOnce({
        data: { status: "Accepted", job_id: "job-1", created_at: "2026-09-25T12:00:01.000Z" },
      });

    await expect(service.compareSelfieToImage(input)).resolves.toEqual({
      jobId: "job-1",
      createdAt: "2026-09-25T12:00:01.000Z",
    });

    const compareBody = mockAxiosInstance.post.mock.calls[1]?.[1] as FormData;
    expect(mockAxiosInstance.post).toHaveBeenNthCalledWith(
      2,
      "/v3/compare",
      expect.any(FormData),
      expect.objectContaining({
        headers: expect.objectContaining({ "SmileID-Token": "smile-token" }),
      }),
    );
    expect(compareBody.get("comparison_image_type")).toBe("PORTRAIT");
    expect(JSON.parse(String(compareBody.get("consent")))).toMatchObject({
      granted: true,
      notice_language: "EN",
    });
    expect(JSON.parse(String(compareBody.get("user_details")))).toEqual({
      given_names: "Oyewole",
      last_name: "Balogun",
      email: "driver@example.com",
    });
    expect(compareBody.get("callback_url")).toBe(
      "https://hyre-worker-nestjs.fly.dev/api/smile-id/compare",
    );
  });

  it("rejects a compare request that has neither email nor phone", async () => {
    await expect(
      service.compareSelfieToImage({
        ...input,
        user: { givenNames: "Oyewole", lastName: "Balogun" },
      }),
    ).rejects.toEqual(new SmileIdError("INVALID_RESPONSE"));
    expect(mockAxiosInstance.post).not.toHaveBeenCalled();
  });

  it("accepts a webhook signed with the partner id and api key", () => {
    const timestamp = new Date().toISOString();
    const signature = createHmac("sha256", "smile-key")
      .update(`${timestamp}123sid_request`)
      .digest("base64");

    expect(service.webhookAuthentic(timestamp, signature)).toBe(true);
    expect(service.webhookAuthentic(timestamp, "not-the-signature")).toBe(false);
    expect(service.webhookAuthentic("2020-01-01T00:00:00.000Z", signature)).toBe(false);
  });

  it("confirms a compare callback against the Smile ID job status", async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({ data: { token: "smile-token" } });
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: { status: "clear", job_id: "job-1" },
    });

    await expect(service.comparisonStatus("job-1")).resolves.toBe("clear");
    expect(mockAxiosInstance.get).toHaveBeenCalledWith(
      "/v3/status/job-1",
      expect.objectContaining({
        headers: { "SmileID-Token": "smile-token" },
      }),
    );
  });

  it("reports Smile ID as unavailable when authentication fails", async () => {
    mockAxiosInstance.post.mockRejectedValueOnce(
      createAxiosErrorWithResponse(HttpStatus.UNAUTHORIZED),
    );

    await expect(service.compareSelfieToImage(input)).rejects.toEqual(
      new SmileIdError("UNAVAILABLE"),
    );
  });
});
