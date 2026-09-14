import { z } from "zod";

export const bookingPaymentStatusQuerySchema = z.object({
  txRef: z.string().min(1, "Transaction reference is required"),
  bookingId: z.uuid("Booking ID must be a valid UUID"),
});

export type BookingPaymentStatusQueryDto = z.infer<typeof bookingPaymentStatusQuerySchema>;
