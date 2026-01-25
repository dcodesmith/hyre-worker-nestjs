import { Logger } from "@nestjs/common";
import { z } from "zod";

const logger = new Logger("EnvConfig");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.url("REDIS_URL must be a valid URL"),
  RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required"),
  RESEND_FROM_EMAIL: z.email("RESEND_FROM_EMAIL must be a valid email"),

  APP_NAME: z.string().min(1, "APP_NAME is required"),
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

  TWILIO_ACCOUNT_SID: z.string().min(1, "TWILIO_ACCOUNT_SID is required"),
  TWILIO_AUTH_TOKEN: z.string().min(1, "TWILIO_AUTH_TOKEN is required"),
  TWILIO_SECRET: z.string().min(1, "TWILIO_SECRET is required"),
  TWILIO_WHATSAPP_NUMBER: z.string().min(1, "TWILIO_WHATSAPP_NUMBER is required"),
  TWILIO_WEBHOOK_URL: z.url("TWILIO_WEBHOOK_URL must be a valid URL").optional(),

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

  // Auth configuration (optional - only required when AuthModule is used)
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters").optional(),
  AUTH_BASE_URL: z.url("AUTH_BASE_URL must be a valid URL").optional(),
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
    )
    .optional(),
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
