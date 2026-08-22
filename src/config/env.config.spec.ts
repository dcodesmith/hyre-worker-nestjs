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
        TWILIO_FLIGHT_OPERATIONAL_UPDATE_CONTENT_SID: "",
        TWILIO_PAYOUT_SUCCEEDED_CONTENT_SID: "",
        TWILIO_REFUND_SUCCEEDED_CONTENT_SID: "",
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

describe("envSchema booking modification cutoff", () => {
  it("defaults to 12 hours", () => {
    const result = envSchema.parse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
    });

    expect(result.BOOKING_MODIFICATION_CUTOFF_HOURS).toBe(12);
  });

  it("accepts a positive integer override", () => {
    const result = envSchema.parse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
      BOOKING_MODIFICATION_CUTOFF_HOURS: "24",
    });

    expect(result.BOOKING_MODIFICATION_CUTOFF_HOURS).toBe(24);
  });
});

describe("envSchema storage driver", () => {
  const r2Env = {
    ...productionEnv,
    OPERATIONS_EMAIL: "operations@example.com",
    STORAGE_DRIVER: "r2",
    AWS_REGION: undefined,
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    AWS_BUCKET_NAME: undefined,
    R2_ACCOUNT_ID: "ea5151b6637ce5379c9fea75e7e52aaa",
    R2_ACCESS_KEY_ID: "r2-access-key",
    R2_SECRET_ACCESS_KEY: "r2-secret-key",
    R2_IMAGES_BUCKET_NAME: "hyre-assets-images-development",
    ASSET_PUBLIC_BASE_URL: "https://images-dev.tripdly.com",
  };

  it("defaults to s3", () => {
    const result = envSchema.parse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
    });

    expect(result.STORAGE_DRIVER).toBe("s3");
  });

  it("requires AWS credentials when STORAGE_DRIVER is s3", () => {
    const result = envSchema.safeParse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
      AWS_ACCESS_KEY_ID: undefined,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["AWS_ACCESS_KEY_ID"],
            message: "AWS_ACCESS_KEY_ID is required when STORAGE_DRIVER=s3",
          }),
        ]),
      );
    }
  });

  it("accepts R2 configuration without AWS credentials", () => {
    const result = envSchema.safeParse(r2Env);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.STORAGE_DRIVER).toBe("r2");
      expect(result.data.R2_IMAGES_BUCKET_NAME).toBe("hyre-assets-images-development");
    }
  });

  it("requires R2 credentials when STORAGE_DRIVER is r2", () => {
    const result = envSchema.safeParse({
      ...r2Env,
      R2_ACCESS_KEY_ID: undefined,
      ASSET_PUBLIC_BASE_URL: undefined,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["R2_ACCESS_KEY_ID"],
            message: "R2_ACCESS_KEY_ID is required when STORAGE_DRIVER=r2",
          }),
          expect.objectContaining({
            path: ["ASSET_PUBLIC_BASE_URL"],
            message: "ASSET_PUBLIC_BASE_URL is required when STORAGE_DRIVER=r2",
          }),
        ]),
      );
    }
  });

  it("treats blank unused storage keys as omitted", () => {
    const result = envSchema.safeParse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
      R2_ACCOUNT_ID: "",
      ASSET_PUBLIC_BASE_URL: "",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.R2_ACCOUNT_ID).toBeUndefined();
      expect(result.data.ASSET_PUBLIC_BASE_URL).toBeUndefined();
    }
  });
});

describe("envSchema APP_ENV", () => {
  it("defaults to development", () => {
    const result = envSchema.parse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
    });

    expect(result.APP_ENV).toBe("development");
  });

  it("accepts preview", () => {
    const result = envSchema.parse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
      APP_ENV: "preview",
    });

    expect(result.APP_ENV).toBe("preview");
  });

  it("accepts production", () => {
    const result = envSchema.parse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
      APP_ENV: "production",
    });

    expect(result.APP_ENV).toBe("production");
  });
});
