import type { Promotion } from "@prisma/client";
import type Decimal from "decimal.js";

export type ActivePromotion = Pick<
  Promotion,
  "id" | "name" | "discountValue" | "startDate" | "endDate" | "carId" | "createdAt"
>;

export type PromotionListItem = {
  id: string;
  ownerId: string;
  carId: string | null;
  name: string | null;
  discountValue: number;
  startDate: string;
  endDate: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  car: {
    id: string;
    make: string;
    model: string;
    year: number;
    registrationNumber: string;
  } | null;
};

export type PromotionForCreate = {
  ownerId: string;
  carId?: string | null;
  name?: string;
  discountValue: number;
  startDate: Date;
  endDate: Date;
};

export type PromotionWindowInput = {
  startDate: string;
  endDateInclusive: string;
  timeZone?: string;
};

export type PromotionDiscountInput = {
  originalRate: Decimal;
  discountPercent: Decimal;
};
