import { BookingType } from "@prisma/client";
import { z } from "zod";
import { pickupTimeRegex } from "./pickup-time.regex";

export const pricingPreviewBodySchema = z
  .object({
    carId: z.string().min(1, "Car ID is required"),
    bookingType: z.enum(Object.values(BookingType) as [BookingType, ...BookingType[]]),
    startDate: z.coerce.date("Invalid start date format"),
    endDate: z.coerce.date("Invalid end date format"),
    pickupTime: z.string().min(1, "Pickup time is required"),
    includeSecurityDetail: z.boolean().default(false),
    requiresFullTank: z.boolean().default(false),
  })
  .refine((data) => data.endDate > data.startDate, {
    message: "End date must be after start date",
    path: ["endDate"],
  })
  .refine((data) => pickupTimeRegex.test(data.pickupTime.trim()), {
    message: "Pickup time is required for all bookings (format: H:MM AM/PM)",
    path: ["pickupTime"],
  });

export type PricingPreviewBodyDto = z.infer<typeof pricingPreviewBodySchema>;

export type PricingPreviewDiscountCoverage = "NONE" | "PARTIAL" | "FULL";

export type PricingPreviewSegmentKind = "PROMO" | "STANDARD";

export interface PricingPreviewPromotionDto {
  id: string;
  name: string | null;
  discountValue: number;
  startDate?: string;
  endDateExclusive?: string;
}

export interface PricingPreviewSegmentDto {
  kind: PricingPreviewSegmentKind;
  units: number;
  unitPrice: number;
  total: number;
  compareAtUnitPrice: number | null;
  label: string | null;
  promotion: PricingPreviewPromotionDto | null;
}

export interface BookingPricingPreviewResponseDto {
  currency: "NGN";
  numberOfLegs: number;
  discountCoverage: PricingPreviewDiscountCoverage;
  segments: PricingPreviewSegmentDto[];
  baseTotal: number;
  compareAtBaseTotal: number;
  securityDetailCost: number;
  fuelUpgradeCost: number;
  platformFeeRatePercent: number;
  platformFeeAmount: number;
  compareAtPlatformFeeAmount: number;
  subtotalBeforeDiscounts: number;
  compareAtSubtotalBeforeDiscounts: number;
  referralDiscountAmount: number;
  creditsUsed: number;
  subtotalAfterDiscounts: number;
  vatRatePercent: number;
  vatAmount: number;
  compareAtVatAmount: number;
  totalAmount: number;
  compareAtTotalAmount: number;
  savingsAmount: number;
}
