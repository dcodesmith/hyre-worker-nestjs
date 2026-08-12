import { BookingValidationException } from "./booking.error";

export function validateCreditsRequireAuthentication(
  useCredits: number,
  sessionUser: { id: string } | null,
): void {
  if (!sessionUser && useCredits > 0) {
    throw new BookingValidationException(
      [{ field: "useCredits", message: "Sign in to apply referral credits" }],
      "Referral credits require authentication",
    );
  }
}
