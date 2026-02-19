import type { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import twilio from "twilio";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TwilioWebhookGuard } from "./twilio-webhook.guard";

describe("TwilioWebhookGuard", () => {
  let guard: TwilioWebhookGuard;

  const authToken = "test-twilio-auth-token";
  const webhookUrl = "http://localhost:3000/api/messaging/webhook/twilio";

  const createContext = (
    headers: Record<string, string | undefined>,
    body: Record<string, unknown> = {},
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
          body,
        }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TwilioWebhookGuard,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => {
              if (key === "TWILIO_AUTH_TOKEN") return authToken;
              if (key === "TWILIO_WEBHOOK_URL") return webhookUrl;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<TwilioWebhookGuard>(TwilioWebhookGuard);
  });

  it("allows request with valid Twilio signature", () => {
    const params = { MessageSid: "SM123", MessageStatus: "delivered" };
    const signature = twilio.getExpectedTwilioSignature(authToken, webhookUrl, params);
    const context = createContext({ "x-twilio-signature": signature }, params);

    expect(guard.canActivate(context)).toBe(true);
  });

  it("rejects request with invalid signature", () => {
    const context = createContext(
      { "x-twilio-signature": "invalid-signature" },
      { MessageSid: "SM123" },
    );

    expect(guard.canActivate(context)).toBe(false);
  });

  it("rejects request when signature header is missing", () => {
    const context = createContext({}, { MessageSid: "SM123" });

    expect(guard.canActivate(context)).toBe(false);
  });
});
