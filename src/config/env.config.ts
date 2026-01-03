import { z } from "zod";

export const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    // Redis: Either REDIS_URL (local/test) OR Upstash (production)
    REDIS_URL: z.url("REDIS_URL must be a valid URL").optional(),
    UPSTASH_REDIS_REST_URL: z.url("UPSTASH_REDIS_REST_URL must be a valid URL").optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
    RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required"),
    RESEND_FROM_EMAIL: z.email("RESEND_FROM_EMAIL must be a valid email"),
    APP_NAME: z.string().min(1, "APP_NAME is required"),
    PORT: z.coerce.number().default(3000),
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
          message: "TIMEZONE must be a valid IANA timezone (e.g., Africa/Lagos, America/New_York)",
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

    ENABLE_MANUAL_TRIGGERS: z
      .union([z.boolean(), z.string()])
      .transform((val) => {
        if (typeof val === "boolean") return val;
        return val.toLowerCase() === "true";
      })
      .default(false),
  })
  .refine(
    (data) => {
      // Either REDIS_URL OR (UPSTASH_REDIS_REST_URL AND UPSTASH_REDIS_REST_TOKEN) must be provided
      const hasRedisUrl = !!data.REDIS_URL;
      const hasUpstash = !!(data.UPSTASH_REDIS_REST_URL && data.UPSTASH_REDIS_REST_TOKEN);
      return hasRedisUrl || hasUpstash;
    },
    {
      message:
        "Either REDIS_URL or both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be provided",
    },
  );

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnvironment(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ");

    throw new Error(`Invalid environment configuration. Please check your .env file. ${errors}`);
  }

  console.log("Environment variables validated successfully");
  return result.data;
}
