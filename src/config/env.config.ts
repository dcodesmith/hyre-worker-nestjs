import { z } from "zod";

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.url("REDIS_URL must be a valid URL"),
  RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required"),
  APP_NAME: z.string().min(1, "APP_NAME is required"),
  PORT: z.coerce.number().default(3000),

  TWILIO_ACCOUNT_SID: z.string().min(1, "TWILIO_ACCOUNT_SID is required"),
  TWILIO_AUTH_TOKEN: z.string().min(1, "TWILIO_AUTH_TOKEN is required"),
  TWILIO_SECRET: z.string().min(1, "TWILIO_SECRET is required"),
  TWILIO_WHATSAPP_NUMBER: z.coerce
    .number()
    .positive("TWILIO_WHATSAPP_NUMBER must be a valid number"),
  TWILIO_WEBHOOK_URL: z.string().optional(),

  FLUTTERWAVE_SECRET_KEY: z.string().min(1, "FLUTTERWAVE_SECRET_KEY is required"),
  FLUTTERWAVE_PUBLIC_KEY: z.string().min(1, "FLUTTERWAVE_PUBLIC_KEY is required"),
  FLUTTERWAVE_BASE_URL: z.url("FLUTTERWAVE_BASE_URL must be a valid URL"),
  FLUTTERWAVE_WEBHOOK_SECRET: z.string().min(1, "FLUTTERWAVE_WEBHOOK_SECRET is required"),
  FLUTTERWAVE_WEBHOOK_URL: z.url("FLUTTERWAVE_WEBHOOK_URL must be a valid URL"),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnvironment(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    console.error("❌ Environment validation failed:");

    for (const [field, messages] of Object.entries(errors)) {
      console.error(`  ${field}: ${messages?.join(", ")}`);
    }

    throw new Error("Invalid environment configuration. Please check your .env file.");
  }

  console.log("✅ Environment variables validated successfully");
  return result.data;
}
