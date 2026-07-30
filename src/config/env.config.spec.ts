import { describe, expect, it } from "vitest";
import { envSchema } from "./env.config";

const productionEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:password@localhost:5432/hyre",
  REDIS_URL: "redis://localhost:6379",
  EMAIL_PROVIDER: "smtp",
  APP_NAME: "Hyre",
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_SECRET: "secret",
  TWILIO_WHATSAPP_NUMBER: "+1234567890",
  TWILIO_BOOKING_STATUS_UPDATE_CONTENT_SID: "HX1234567890abcdef1234567890abcdef",
  TWILIO_CLIENT_BOOKING_LEG_START_REMINDER_CONTENT_SID: "HX1234567890abcdef1234567890abcdef",
  TWILIO_CHAUFFEUR_BOOKING_LEG_START_REMINDER_CONTENT_SID: "HX1234567890abcdef1234567890abcdef",
  TWILIO_CLIENT_BOOKING_LEG_END_REMINDER_CONTENT_SID: "HX1234567890abcdef1234567890abcdef",
  TWILIO_CHAUFFEUR_BOOKING_LEG_END_REMINDER_CONTENT_SID: "HX1234567890abcdef1234567890abcdef",
  TWILIO_BOOKING_CONFIRMATION_CONTENT_SID: "HX1234567890abcdef1234567890abcdef",
  TWILIO_BOOKING_CANCELLATION_CLIENT_CONTENT_SID: "HX1234567890abcdef1234567890abcdef",
  TWILIO_BOOKING_CANCELLATION_FLEET_OWNER_CONTENT_SID: "HX1234567890abcdef1234567890abcdef",
  TWILIO_FLEET_OWNER_BOOKING_NOTIFICATION_CONTENT_SID: "HX1234567890abcdef1234567890abcdef",
  TWILIO_BOOKING_EXTENSION_CONFIRMATION_CONTENT_SID: "HX1234567890abcdef1234567890abcdef",
  FLUTTERWAVE_SECRET_KEY: "secret",
  FLUTTERWAVE_PUBLIC_KEY: "public",
  FLUTTERWAVE_BASE_URL: "https://api.flutterwave.com",
  FLUTTERWAVE_WEBHOOK_SECRET: "webhook-secret",
  FLUTTERWAVE_WEBHOOK_URL: "https://example.com/webhooks/flutterwave",
  HMAC_KEY: "hmac-key",
  FLIGHTAWARE_API_KEY: "flightaware-key",
  FLIGHTAWARE_WEBHOOK_SECRET: "flightaware-secret",
  GOOGLE_DISTANCE_MATRIX_API_KEY: "google-key",
  OPENAI_API_KEY: "openai-key",
  SESSION_SECRET: "12345678901234567890123456789012",
  AUTH_BASE_URL: "https://example.com",
  TRUSTED_ORIGINS: "https://example.com",
  SENDER_NAME: "Hyre",
  AWS_REGION: "eu-west-1",
  AWS_ACCESS_KEY_ID: "access-key",
  AWS_SECRET_ACCESS_KEY: "secret-key",
  AWS_BUCKET_NAME: "hyre-test",
  ANTHROPIC_API_KEY: "anthropic-key",
} as const;

describe("envSchema operations email", () => {
  it("requires an operations email in production", () => {
    const result = envSchema.safeParse(productionEnv);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["OPERATIONS_EMAIL"],
            message: "OPERATIONS_EMAIL is required in production",
          }),
        ]),
      );
    }
  });

  it("accepts a valid production operations email", () => {
    expect(
      envSchema.safeParse({
        ...productionEnv,
        OPERATIONS_EMAIL: "operations@example.com",
      }).success,
    ).toBe(true);
  });

  it("requires core WhatsApp template SIDs in production", () => {
    const result = envSchema.safeParse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
      TWILIO_BOOKING_STATUS_UPDATE_CONTENT_SID: undefined,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["TWILIO_BOOKING_STATUS_UPDATE_CONTENT_SID"],
            message: "TWILIO_BOOKING_STATUS_UPDATE_CONTENT_SID is required in production",
          }),
        ]),
      );
    }
  });
});
