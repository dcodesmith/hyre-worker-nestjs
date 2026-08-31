import { z } from "zod";

export const guestBookingAccessRequestSchema = z.object({
  bookingReference: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .transform((value) => value.toUpperCase()),
  email: z
    .string()
    .trim()
    .pipe(z.email("Invalid email address"))
    .transform((value) => value.toLowerCase()),
});

export const guestBookingAccessTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Invalid guest booking access token");

export const guestBookingAccessQuerySchema = z.object({
  token: guestBookingAccessTokenSchema,
});

export type GuestBookingAccessRequestDto = z.infer<typeof guestBookingAccessRequestSchema>;
export type GuestBookingAccessQueryDto = z.infer<typeof guestBookingAccessQuerySchema>;
