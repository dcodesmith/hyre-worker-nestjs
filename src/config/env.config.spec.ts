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
  TWILIO_VERIFY_SERVICE_SID: "VA123",
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
  TWILIO_VEHICLE_CARD_CONTENT_SID: "HX1234567890abcdef1234567890abcdef",
  TWILIO_CHECKOUT_LINK_CONTENT_SID: "HX1234567890abcdef1234567890abcdef",
  FLUTTERWAVE_SECRET_KEY: "secret",
  FLUTTERWAVE_PUBLIC_KEY: "public",
  FLUTTERWAVE_BASE_URL: "https://api.flutterwave.com",
  FLUTTERWAVE_WEBHOOK_SECRET: "webhook-secret",
  FLUTTERWAVE_WEBHOOK_URL: "https://example.com/webhooks/flutterwave",
  PREMBLY_API_KEY: "prembly-key",
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
    R2_DOCS_BUCKET_NAME: "hyre-assets-docs-development",
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
      expect(result.data.R2_DOCS_BUCKET_NAME).toBe("hyre-assets-docs-development");
    }
  });

  it("requires R2 credentials when STORAGE_DRIVER is r2", () => {
    const result = envSchema.safeParse({
      ...r2Env,
      R2_ACCESS_KEY_ID: undefined,
      R2_DOCS_BUCKET_NAME: undefined,
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
            path: ["R2_DOCS_BUCKET_NAME"],
            message: "R2_DOCS_BUCKET_NAME is required when STORAGE_DRIVER=r2",
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

describe("envSchema LangGraph models", () => {
  it("allows optional model overrides", () => {
    const result = envSchema.parse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
      NODE_ENV: "development",
      LANGGRAPH_EXTRACTION_MODEL: "gpt-4o-mini",
      LANGGRAPH_RESPONSE_MODEL: "claude-sonnet-4-20250514",
    });

    expect(result.LANGGRAPH_EXTRACTION_MODEL).toBe("gpt-4o-mini");
    expect(result.LANGGRAPH_RESPONSE_MODEL).toBe("claude-sonnet-4-20250514");
  });
});

describe("envSchema WhatsApp agent templates", () => {
  it("treats agent template SIDs as optional overrides in every environment", () => {
    expect(
      envSchema.safeParse({
        ...productionEnv,
        OPERATIONS_EMAIL: "operations@example.com",
        APP_ENV: "production",
        TWILIO_VEHICLE_CARD_CONTENT_SID: undefined,
        TWILIO_CHECKOUT_LINK_CONTENT_SID: undefined,
      }).success,
    ).toBe(true);

    const overridden = envSchema.parse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
      TWILIO_VEHICLE_CARD_CONTENT_SID: "HXcccccccccccccccccccccccccccccccc",
      TWILIO_CHECKOUT_LINK_CONTENT_SID: "HXdddddddddddddddddddddddddddddddd",
    });

    expect(overridden.TWILIO_VEHICLE_CARD_CONTENT_SID).toBe("HXcccccccccccccccccccccccccccccccc");
    expect(overridden.TWILIO_CHECKOUT_LINK_CONTENT_SID).toBe("HXdddddddddddddddddddddddddddddddd");
  });
});

describe("envSchema deployment metadata", () => {
  it("uses local defaults", () => {
    const result = envSchema.parse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
    });

    expect(result.DEPLOYMENT_VERSION).toBe("local");
    expect(result.DEPLOYMENT_COMMIT).toBe("local");
  });

  it("accepts a deployment version and full git SHA", () => {
    const result = envSchema.parse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
      DEPLOYMENT_VERSION: "v1.0.0",
      DEPLOYMENT_COMMIT: "a".repeat(40),
    });

    expect(result.DEPLOYMENT_VERSION).toBe("v1.0.0");
    expect(result.DEPLOYMENT_COMMIT).toBe("a".repeat(40));
  });

  it("rejects an abbreviated deployment commit", () => {
    const result = envSchema.safeParse({
      ...productionEnv,
      OPERATIONS_EMAIL: "operations@example.com",
      DEPLOYMENT_COMMIT: "abc1234",
    });

    expect(result.success).toBe(false);
  });
});

describe("envSchema OTLP exporters", () => {
  const baseEnv = {
    ...productionEnv,
    OPERATIONS_EMAIL: "operations@example.com",
  };

  it("accepts optional Grafana Cloud OTLP settings", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway-prod-us-east-0.grafana.net/otlp",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://tempo.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://mimir.example.com/v1/metrics",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20dGVzdA==",
      OTEL_SERVICE_NAME: "hyre-worker-nestjs",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
        "https://otlp-gateway-prod-us-east-0.grafana.net/otlp",
      );
      expect(result.data.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(
        "https://tempo.example.com/v1/traces",
      );
      expect(result.data.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe(
        "https://mimir.example.com/v1/metrics",
      );
      expect(result.data.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("http://127.0.0.1:4318/v1/logs");
      expect(result.data.OTEL_EXPORTER_OTLP_HEADERS).toBe("Authorization=Basic%20dGVzdA==");
      expect(result.data.OTEL_SERVICE_NAME).toBe("hyre-worker-nestjs");
    }
  });

  it("treats blank optional OTLP values as omitted", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_HEADERS: "",
      OTEL_SERVICE_NAME: "",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
      expect(result.data.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined();
      expect(result.data.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBeUndefined();
      expect(result.data.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined();
      expect(result.data.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
      expect(result.data.OTEL_SERVICE_NAME).toBeUndefined();
    }
  });

  it("rejects a non-URL OTLP endpoint", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["OTEL_EXPORTER_OTLP_ENDPOINT"],
          }),
        ]),
      );
    }
  });

  it("rejects a non-http OTLP endpoint protocol", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "ftp://traces.example.com/v1/traces",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"],
            message: "OTLP endpoint must use http:// or https://",
          }),
        ]),
      );
    }
  });
});

describe("envSchema SENTRY_DSN", () => {
  const baseEnv = {
    ...productionEnv,
    OPERATIONS_EMAIL: "operations@example.com",
  };

  it("accepts a valid optional Sentry DSN", () => {
    const omitted = envSchema.safeParse(baseEnv);
    expect(omitted.success).toBe(true);
    if (omitted.success) {
      expect(omitted.data.SENTRY_DSN).toBeUndefined();
    }

    const result = envSchema.safeParse({
      ...baseEnv,
      SENTRY_DSN: "https://abc123@o123.ingest.sentry.io/456",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SENTRY_DSN).toBe("https://abc123@o123.ingest.sentry.io/456");
    }
  });

  it("treats a blank SENTRY_DSN as omitted", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      SENTRY_DSN: "",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SENTRY_DSN).toBeUndefined();
    }
  });

  it("rejects a malformed SENTRY_DSN", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      SENTRY_DSN: "not-a-url",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["SENTRY_DSN"],
            message: "SENTRY_DSN must use http:// or https://",
          }),
        ]),
      );
    }
  });

  it("rejects a non-http SENTRY_DSN protocol", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      SENTRY_DSN: "ftp://abc123@o123.ingest.sentry.io/456",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["SENTRY_DSN"],
            message: "SENTRY_DSN must use http:// or https://",
          }),
        ]),
      );
    }
  });
});

describe("envSchema GRAFANA_TRACES_BASE_URL", () => {
  const baseEnv = {
    ...productionEnv,
    OPERATIONS_EMAIL: "operations@example.com",
  };
  const grafanaOrigin = "https://gallantcricket1373.grafana.net";

  it("accepts a valid optional Grafana traces URL", () => {
    const omitted = envSchema.safeParse(baseEnv);
    expect(omitted.success).toBe(true);
    if (omitted.success) {
      expect(omitted.data.GRAFANA_TRACES_BASE_URL).toBeUndefined();
    }

    const result = envSchema.safeParse({
      ...baseEnv,
      GRAFANA_TRACES_BASE_URL: grafanaOrigin,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.GRAFANA_TRACES_BASE_URL).toBe(grafanaOrigin);
    }
  });

  it("treats a blank GRAFANA_TRACES_BASE_URL as omitted", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      GRAFANA_TRACES_BASE_URL: "",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.GRAFANA_TRACES_BASE_URL).toBeUndefined();
    }
  });

  it.each([
    "not-a-url",
    "http://gallantcricket1373.grafana.net",
    "ftp://gallantcricket1373.grafana.net",
  ])("rejects %s", (value) => {
    const result = envSchema.safeParse({
      ...baseEnv,
      GRAFANA_TRACES_BASE_URL: value,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["GRAFANA_TRACES_BASE_URL"],
            message: "GRAFANA_TRACES_BASE_URL must use https://",
          }),
        ]),
      );
    }
  });
});
