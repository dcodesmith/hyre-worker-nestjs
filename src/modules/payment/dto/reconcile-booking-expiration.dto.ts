import { z } from "zod";

export const reconcileBookingExpirationSchema = z.object({
  bookingId: z.string().min(1, "Booking ID is required"),
  txRef: z.string().min(1, "Transaction reference is required"),
});

export type ReconcileBookingExpirationDto = z.infer<typeof reconcileBookingExpirationSchema>;
