import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import twilio from "twilio";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";

describe("Messaging E2E Tests", () => {
  let app: INestApplication;
  let twilioAuthToken: string;
  let twilioWebhookUrl: string;

  beforeAll(async () => {
    twilioAuthToken = process.env.TWILIO_AUTH_TOKEN ?? "test-twilio-auth-token";
    twilioWebhookUrl =
      process.env.TWILIO_WEBHOOK_URL ?? "http://localhost:3000/api/messaging/webhook/twilio";

    process.env.TWILIO_AUTH_TOKEN = twilioAuthToken;
    process.env.TWILIO_WEBHOOK_URL = twilioWebhookUrl;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /api/messaging/webhook/twilio rejects invalid signature", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/messaging/webhook/twilio")
      .type("form")
      .set("x-twilio-signature", "invalid-signature")
      .send({
        MessageSid: "SM0001",
        MessageStatus: "delivered",
      });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("POST /api/messaging/webhook/twilio accepts valid signature", async () => {
    const params = {
      MessageSid: "SM0002",
      MessageStatus: "sent",
      To: "+2348000000000",
      From: "+2348111111111",
    };

    const signature = twilio.getExpectedTwilioSignature(twilioAuthToken, twilioWebhookUrl, params);

    const response = await request(app.getHttpServer())
      .post("/api/messaging/webhook/twilio")
      .type("form")
      .set("x-twilio-signature", signature)
      .send(params);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.text).toBe("<Response></Response>");
    expect(response.headers["content-type"]).toContain("application/xml");
  });
});
