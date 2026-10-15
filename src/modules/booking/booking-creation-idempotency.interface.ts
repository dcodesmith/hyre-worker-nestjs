import type { CreateBookingResponse } from "./booking.interface";

export type BookingIdempotencyClaim =
  | { kind: "claimed"; id: string }
  | { kind: "replay"; response: CreateBookingResponse }
  | { kind: "resume"; id: string; bookingId: string };

export interface ClaimBookingIdempotencyParams {
  customerScope: string;
  idempotencyKey: string;
  requestHash: string;
  attempt: number;
}

export interface CheckpointPaymentResultParams {
  idempotencyId: string;
  bookingId: string;
  paymentIntentId: string;
  reservationExpiresAt: Date;
  paymentStatusTokenHash: string | null;
  response: CreateBookingResponse;
}
