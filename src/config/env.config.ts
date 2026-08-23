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
  if (env.STORAGE_DRIVER === "r2") {
    requireEnvKeys(
      env,
      ctx,
      [
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_IMAGES_BUCKET_NAME",
        "R2_DOCS_BUCKET_NAME",
        "ASSET_PUBLIC_BASE_URL",
      ],
      "when STORAGE_DRIVER=r2",
    );
    return;
  }

  requireEnvKeys(
    env,
    ctx,
    ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_BUCKET_NAME"],
    "when STORAGE_DRIVER=s3",
  );
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

    // Object storage (S3 today; set STORAGE_DRIVER=r2 to use Cloudflare R2)
    STORAGE_DRIVER: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["s3", "r2"]).default("s3"),
    ),
    AWS_REGION: optionalNonEmptyString,
    AWS_ACCESS_KEY_ID: optionalNonEmptyString,
    AWS_SECRET_ACCESS_KEY: optionalNonEmptyString,
    AWS_BUCKET_NAME: optionalNonEmptyString,
    R2_ACCOUNT_ID: optionalNonEmptyString,
    R2_ACCESS_KEY_ID: optionalNonEmptyString,
    R2_SECRET_ACCESS_KEY: optionalNonEmptyString,
    R2_IMAGES_BUCKET_NAME: optionalNonEmptyString,
    R2_DOCS_BUCKET_NAME: optionalNonEmptyString,
    ASSET_PUBLIC_BASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url("ASSET_PUBLIC_BASE_URL must be a valid URL").optional(),
    ),

    // LangGraph Agent configuration
    ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required for LangGraph agent"),
    LANGGRAPH_HISTORY_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
    LANGGRAPH_HISTORY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
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
