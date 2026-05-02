import { z } from "zod";

export const bookingPaymentStatusQuerySchema = z.object({
  txRef: z.string().min(1, "Transaction reference is required"),
  bookingId: z.string().min(1, "Booking ID is required"),
  guestEmail: z.email("Invalid guest email address").optional(),
});

export type BookingPaymentStatusQueryDto = z.infer<typeof bookingPaymentStatusQuerySchema>;
