import { z } from "zod";

export const reconcileBookingExpirationSchema = z.object({
  bookingId: z.uuid("Booking ID must be a valid UUID"),
  txRef: z.string().min(1, "Transaction reference is required"),
});

export type ReconcileBookingExpirationDto = z.infer<typeof reconcileBookingExpirationSchema>;
