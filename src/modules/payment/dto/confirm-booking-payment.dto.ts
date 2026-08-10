import { z } from "zod";

export const confirmBookingPaymentSchema = z.object({
  bookingId: z.string().min(1, "Booking ID is required"),
  txRef: z.string().min(1, "Transaction reference is required"),
  transactionId: z
    .string()
    .max(32, "Transaction ID is too long")
    .regex(/^\d+$/, "Transaction ID must be numeric")
    .refine((value) => Number.isSafeInteger(Number(value)), "Transaction ID is invalid"),
});

export type ConfirmBookingPaymentDto = z.infer<typeof confirmBookingPaymentSchema>;
