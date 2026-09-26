import { Logger } from "@nestjs/common";
import { z } from "zod";

const logger = new Logger("EnvConfig");
const twilioContentSidSchema = z
  .string()
  .regex(/^HX[a-fA-F0-9]{32}$/, "Invalid Twilio Content SID");
const optionalTwilioContentSidSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  twilioContentSidSchema.optional(),
);
const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const optionalUrl = (protocol: RegExp, error: string) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .url({
        protocol,
        error,
      })
      .optional(),
  );
const optionalOtlpHttpUrl = optionalUrl(/^https?$/, "OTLP endpoint must use http:// or https://");
const optionalSentryDsn = optionalUrl(/^https?$/, "SENTRY_DSN must use http:// or https://");
const requiredTwilioContentSidKeys = [
  "TWILIO_BOOKING_STATUS_UPDATE_CONTENT_SID",
  "TWILIO_CLIENT_BOOKING_LEG_START_REMINDER_CONTENT_SID",
  "TWILIO_CHAUFFEUR_BOOKING_LEG_START_REMINDER_CONTENT_SID",
  "TWILIO_CLIENT_BOOKING_LEG_END_REMINDER_CONTENT_SID",
  "TWILIO_CHAUFFEUR_BOOKING_LEG_END_REMINDER_CONTENT_SID",
  "TWILIO_BOOKING_CONFIRMATION_CONTENT_SID",
  "TWILIO_BOOKING_CANCELLATION_CLIENT_CONTENT_SID",
  "TWILIO_BOOKING_CANCELLATION_FLEET_OWNER_CONTENT_SID",
  "TWILIO_FLEET_OWNER_BOOKING_NOTIFICATION_CONTENT_SID",
  "TWILIO_BOOKING_EXTENSION_CONFIRMATION_CONTENT_SID",
] as const;

type EnvIssueContext = {
  addIssue(issue: { code: "custom"; path: string[]; message: string }): void;
};

function requireEnvKeys(
  env: Record<string, unknown>,
  ctx: EnvIssueContext,
  keys: readonly string[],
  reason: string,
): void {
  for (const key of keys) {
    if (typeof env[key] !== "string" || env[key].length === 0) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required ${reason}`,
      });
    }
  }
}

function validateStorageConfiguration(env: Record<string, unknown>, ctx: EnvIssueContext): void {
  if (env.APP_ENV === "preview") {
    requireEnvKeys(env, ctx, ["STORAGE_WRITE_PREFIX"], "for isolated R2 preview writes");
    return;
  }

  if (env.STORAGE_WRITE_PREFIX) {
    ctx.addIssue({
      code: "custom",
      path: ["STORAGE_WRITE_PREFIX"],
      message: "STORAGE_WRITE_PREFIX is only allowed when APP_ENV=preview",
    });
  }
}

function validateProductionConfiguration(env: Record<string, unknown>, ctx: EnvIssueContext): void {
  if (env.NODE_ENV !== "production") {
    return;
  }

  if (!env.OPERATIONS_EMAIL) {
    ctx.addIssue({
      code: "custom",
      path: ["OPERATIONS_EMAIL"],
      message: "OPERATIONS_EMAIL is required in production",
    });
  }

  for (const key of requiredTwilioContentSidKeys) {
    if (!env[key]) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required in production`,
      });
    }
  }

  if (
    env.APP_ENV === "production" &&
    (typeof env.SMILE_ID_BASE_URL !== "string" ||
      env.SMILE_ID_BASE_URL.includes("testapi.smileidentity.com"))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["SMILE_ID_BASE_URL"],
      message: "SMILE_ID_BASE_URL must be the production Smile ID API",
    });
  }
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.url("REDIS_URL must be a valid URL").refine(
      (value) => {
        const protocol = new URL(value).protocol;
        return protocol === "redis:" || protocol === "rediss:";
      },
      { error: "REDIS_URL must use redis:// or rediss://" },
    ),

    EMAIL_PROVIDER: z.enum(["resend", "smtp"]).optional(),
    EMAIL_FROM: z.email("EMAIL_FROM must be a valid email").optional(),
    OPERATIONS_EMAIL: z.email("OPERATIONS_EMAIL must be a valid email").optional(),
    RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required").optional(),
    RESEND_FROM_EMAIL: z.email("RESEND_FROM_EMAIL must be a valid email").optional(),
    SMTP_HOST: z.string().default("127.0.0.1"),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_SECURE: z
      .preprocess((val) => {
        if (typeof val === "string") {
          const normalized = val.toLowerCase();
          if (normalized === "true") return true;
          if (normalized === "false") return false;
        }
        return val;
      }, z.boolean("SMTP_SECURE must be a boolean or 'true'/'false'"))
      .default(false),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),

    APP_NAME: z.string().min(1, "APP_NAME is required"),
    APP_ENV: z.enum(["preview", "development", "production"]).default("development"),
    DEPLOYMENT_COMMIT: z
      .union([
        z.literal("local"),
        z.string().regex(/^[0-9a-f]{40}$/i, "DEPLOYMENT_COMMIT must be a full git SHA"),
      ])
      .default("local"),
    DEPLOYMENT_VERSION: z.string().min(1).max(128).default("local"),
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalOtlpHttpUrl,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: optionalOtlpHttpUrl,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: optionalOtlpHttpUrl,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: optionalOtlpHttpUrl,
    OTEL_EXPORTER_OTLP_HEADERS: optionalNonEmptyString,
    OTEL_SERVICE_NAME: optionalNonEmptyString,
    SENTRY_DSN: optionalSentryDsn,
    GRAFANA_TRACES_BASE_URL: optionalUrl(/^https$/, "GRAFANA_TRACES_BASE_URL must use https://"),
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default("0.0.0.0"),
    TZ: z
      .string()
      .default("Africa/Lagos")
      .refine(
        (tz) => {
          try {
            Intl.DateTimeFormat(undefined, { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        },
        {
          error: "TIMEZONE must be a valid IANA timezone (e.g., Africa/Lagos, America/New_York)",
        },
      ),
    BOOKING_MODIFICATION_CUTOFF_HOURS: z.coerce.number().int().positive().default(12),

    TWILIO_ACCOUNT_SID: z.string().min(1, "TWILIO_ACCOUNT_SID is required"),
    TWILIO_AUTH_TOKEN: z.string().min(1, "TWILIO_AUTH_TOKEN is required"),
    TWILIO_VERIFY_SERVICE_SID: z.string().min(1, "TWILIO_VERIFY_SERVICE_SID is required"),
    TWILIO_SECRET: z.string().min(1, "TWILIO_SECRET is required"),
    TWILIO_WHATSAPP_NUMBER: z.string().min(1, "TWILIO_WHATSAPP_NUMBER is required"),
    TWILIO_WEBHOOK_URL: z.url("TWILIO_WEBHOOK_URL must be a valid URL").optional(),
    TWILIO_BOOKING_STATUS_UPDATE_CONTENT_SID: optionalTwilioContentSidSchema,
    TWILIO_CLIENT_BOOKING_LEG_START_REMINDER_CONTENT_SID: optionalTwilioContentSidSchema,
    TWILIO_CHAUFFEUR_BOOKING_LEG_START_REMINDER_CONTENT_SID: optionalTwilioContentSidSchema,
    TWILIO_CLIENT_BOOKING_LEG_END_REMINDER_CONTENT_SID: optionalTwilioContentSidSchema,
    TWILIO_CHAUFFEUR_BOOKING_LEG_END_REMINDER_CONTENT_SID: optionalTwilioContentSidSchema,
    TWILIO_BOOKING_CONFIRMATION_CONTENT_SID: optionalTwilioContentSidSchema,
    TWILIO_BOOKING_CANCELLATION_CLIENT_CONTENT_SID: optionalTwilioContentSidSchema,
    TWILIO_BOOKING_CANCELLATION_FLEET_OWNER_CONTENT_SID: optionalTwilioContentSidSchema,
    TWILIO_FLEET_OWNER_BOOKING_NOTIFICATION_CONTENT_SID: optionalTwilioContentSidSchema,
    TWILIO_BOOKING_EXTENSION_CONFIRMATION_CONTENT_SID: optionalTwilioContentSidSchema,
    TWILIO_FLIGHT_OPERATIONAL_UPDATE_CONTENT_SID: optionalTwilioContentSidSchema,
    TWILIO_PAYOUT_SUCCEEDED_CONTENT_SID: optionalTwilioContentSidSchema,
    TWILIO_REFUND_SUCCEEDED_CONTENT_SID: optionalTwilioContentSidSchema,

    FLUTTERWAVE_SECRET_KEY: z.string().min(1, "FLUTTERWAVE_SECRET_KEY is required"),
    FLUTTERWAVE_PUBLIC_KEY: z.string().min(1, "FLUTTERWAVE_PUBLIC_KEY is required"),
    FLUTTERWAVE_BASE_URL: z.url("FLUTTERWAVE_BASE_URL must be a valid URL"),
    FLUTTERWAVE_WEBHOOK_SECRET: z.string().min(1, "FLUTTERWAVE_WEBHOOK_SECRET is required"),
    FLUTTERWAVE_WEBHOOK_URL: z.url("FLUTTERWAVE_WEBHOOK_URL must be a valid URL"),

    PREMBLY_API_KEY: z.string().min(1, "PREMBLY_API_KEY is required"),
    PREMBLY_APP_ID: optionalNonEmptyString,
    PREMBLY_BASE_URL: z
      .url("PREMBLY_BASE_URL must be a valid URL")
      .default("https://api.prembly.com"),
    REGCHECK_USERNAME: z.string().min(1, "REGCHECK_USERNAME is required"),

    SMILE_ID_PARTNER_ID: z.string().min(1, "SMILE_ID_PARTNER_ID is required"),
    SMILE_ID_API_KEY: z.string().min(1, "SMILE_ID_API_KEY is required"),
    SMILE_ID_BASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url("SMILE_ID_BASE_URL must be a valid URL").default("https://testapi.smileidentity.com"),
    ),
    SMILE_ID_CALLBACK_URL: optionalUrl(/^https$/, "SMILE_ID_CALLBACK_URL must use https://"),

    MONO_SECRET_KEY: z.string().min(1, "MONO_SECRET_KEY is required"),
    MONO_BASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url("MONO_BASE_URL must be a valid URL").default("https://api.withmono.com"),
    ),

    HMAC_KEY: z.string().min(1, "HMAC_KEY is required"),

    ENABLE_MANUAL_TRIGGERS: z
      .union([z.boolean(), z.string()])
      .transform((val) => {
        if (typeof val === "boolean") return val;
        return val.toLowerCase() === "true";
      })
      .default(false),

    API_KEY: z.string().min(8, "API_KEY must be at least 32 characters").optional(),

    BULL_BOARD_USERNAME: z.string().min(1).optional(),
    BULL_BOARD_PASSWORD: z
      .string()
      .min(8, "BULL_BOARD_PASSWORD must be at least 8 characters")
      .optional(),

    // FlightAware configuration (for airport pickup flight validation)
    FLIGHTAWARE_API_KEY: z.string().min(1, "FLIGHTAWARE_API_KEY is required"),
    FLIGHTAWARE_WEBHOOK_SECRET: z.string().min(1, "FLIGHTAWARE_WEBHOOK_SECRET is required"),
    DEFAULT_DESTINATION_CODE: z.string().min(1).default("DNMM"),

    // Google Maps configuration (for drive time calculations)
    GOOGLE_DISTANCE_MATRIX_API_KEY: z.string().min(1, "GOOGLE_DISTANCE_MATRIX_API_KEY is required"),
    OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
    EXPO_ACCESS_TOKEN: z.string().min(1, "EXPO_ACCESS_TOKEN must not be empty").optional(),

    // Auth configuration (optional - only required when AuthModule is used)
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    EDGE_CLIENT_SECRET: z
      .string()
      .min(16, "EDGE_CLIENT_SECRET must be at least 16 characters")
      .optional(),
    AUTH_BASE_URL: z.url("AUTH_BASE_URL must be a valid URL"),
    TRUSTED_ORIGINS: z
      .string()
      .min(1, "TRUSTED_ORIGINS is required")
      .transform((val) =>
        val
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(
        z
          .array(z.url("Each TRUSTED_ORIGIN must be a valid URL"))
          .min(1, "At least one valid TRUSTED_ORIGIN is required"),
      ),
    SENDER_NAME: z.string().min(2, "SENDER_NAME is required"),

    // Cloudflare R2 object storage
    R2_ACCOUNT_ID: z.string().min(1, "R2_ACCOUNT_ID is required"),
    R2_ACCESS_KEY_ID: z.string().min(1, "R2_ACCESS_KEY_ID is required"),
    R2_SECRET_ACCESS_KEY: z.string().min(1, "R2_SECRET_ACCESS_KEY is required"),
    R2_IMAGES_BUCKET_NAME: z.string().min(1, "R2_IMAGES_BUCKET_NAME is required"),
    R2_DOCS_BUCKET_NAME: z.string().min(1, "R2_DOCS_BUCKET_NAME is required"),
    STORAGE_WRITE_PREFIX: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^previews\/pr-[1-9][0-9]*$/, "STORAGE_WRITE_PREFIX must use previews/pr-<number>")
        .optional(),
    ),
    ASSET_PUBLIC_BASE_URL: z.url("ASSET_PUBLIC_BASE_URL must be a valid URL"),

    // LangGraph Agent configuration
    ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required for LangGraph agent"),
    LANGGRAPH_HISTORY_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
  })
  .superRefine((env, ctx) => {
    const hasUsername = typeof env.BULL_BOARD_USERNAME === "string";
    const hasPassword = typeof env.BULL_BOARD_PASSWORD === "string";
    const hasSmtpUser = typeof env.SMTP_USER === "string";
    const hasSmtpPass = typeof env.SMTP_PASS === "string";
    const provider = env.EMAIL_PROVIDER ?? (env.NODE_ENV === "production" ? "resend" : "smtp");

    if (hasUsername !== hasPassword) {
      ctx.addIssue({
        code: "custom",
        path: hasUsername ? ["BULL_BOARD_PASSWORD"] : ["BULL_BOARD_USERNAME"],
        message:
          "BULL_BOARD_USERNAME and BULL_BOARD_PASSWORD must be provided together or both omitted",
      });
    }

    if (hasSmtpUser !== hasSmtpPass) {
      ctx.addIssue({
        code: "custom",
        path: hasSmtpUser ? ["SMTP_PASS"] : ["SMTP_USER"],
        message: "SMTP_USER and SMTP_PASS must be provided together or both omitted",
      });
    }

    if (provider === "resend") {
      if (!env.RESEND_API_KEY) {
        ctx.addIssue({
          code: "custom",
          path: ["RESEND_API_KEY"],
          message: "RESEND_API_KEY is required when EMAIL_PROVIDER=resend",
        });
      }

      if (!env.EMAIL_FROM && !env.RESEND_FROM_EMAIL) {
        ctx.addIssue({
          code: "custom",
          path: ["EMAIL_FROM"],
          message: "EMAIL_FROM or RESEND_FROM_EMAIL must be provided when EMAIL_PROVIDER=resend",
        });
      }
    }

    validateStorageConfiguration(env, ctx);
    validateProductionConfiguration(env, ctx);
  });

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnvironment(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ");

    throw new Error(`Invalid environment configuration. Please check your .env file. ${errors}`);
  }

  logger.log("Environment variables validated successfully");
  return result.data;
}
