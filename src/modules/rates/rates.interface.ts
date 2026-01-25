import type { Decimal } from "@prisma/client/runtime/library";

/**
 * Platform rates used for booking and extension calculations.
 * All percentage rates are stored as decimals (e.g., 10% = 10.00).
 */
export interface PlatformRates {
  /** Platform service fee charged to customer (percentage) */
  platformCustomerServiceFeeRatePercent: Decimal;
  /** Commission taken from fleet owner's earnings (percentage) */
  platformFleetOwnerCommissionRatePercent: Decimal;
  /** VAT rate applied to bookings (percentage) */
  vatRatePercent: Decimal;
  /** Security detail addon rate (flat amount per leg) */
  securityDetailRate: Decimal;
}
