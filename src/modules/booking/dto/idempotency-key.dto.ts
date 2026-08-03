import { z } from "zod";

export const idempotencyKeySchema = z
  .string()
  .min(8, "Idempotency-Key must be at least 8 characters")
  .max(128, "Idempotency-Key must be at most 128 characters")
  .regex(
    /^[A-Za-z0-9._~:-]+$/,
    "Idempotency-Key may only contain safe ASCII letters, numbers, and . _ ~ : -",
  );

export type IdempotencyKeyDto = z.infer<typeof idempotencyKeySchema>;
