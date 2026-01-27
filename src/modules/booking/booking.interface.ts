import type { BookingStatus, Prisma } from "@prisma/client";

export interface CreateBookingResponse {
  bookingId: string;
  bookingReference: string;
  checkoutUrl: string;
  totalAmount: string;
  status: BookingStatus;
}

export type BookingApiResponse = Prisma.BookingGetPayload<{
  include: {
    car: {
      select: {
        id: true;
        make: true;
        model: true;
        year: true;
        plateNumber: true;
        primaryImageUrl: true;
      };
    };
    user: {
      select: {
        id: true;
        name: true;
        email: true;
      };
    };
    legs: true;
  };
}>;

/**
 * Booking financial breakdown for display (all amounts as strings for Decimal precision)
 */
export interface BookingFinancialsResponse {
  netTotal: string;
  securityDetailCost: string;
  fuelUpgradeCost: string;
  netTotalWithAddons: string;
  platformCustomerServiceFeeRatePercent: string;
  platformCustomerServiceFeeAmount: string;
  subtotalBeforeDiscounts: string;
  referralDiscountAmount: string;
  creditsUsed: string;
  subtotalAfterDiscounts: string;
  vatRatePercent: string;
  vatAmount: string;
  totalAmount: string;
  numberOfLegs: number;
  legPrices: Array<{
    legDate: string;
    price: string;
  }>;
}

/**
 * Booking availability check result
 */
export interface CarAvailabilityResult {
  available: boolean;
  conflictingBookings?: Array<{
    id: string;
    startDate: Date;
    endDate: Date;
  }>;
}
