import type { Addon, AddonFinancialTreatment, AddonPrice, AddonPricingUnit } from "@prisma/client";
import type Decimal from "decimal.js";

export interface PublicAddon {
  id: string;
  code: string;
  name: string;
  description: string | null;
  pricingUnit: AddonPricingUnit;
  unitPrice: number;
  currency: "NGN";
}

export interface PublicAddonsResponse {
  addons: PublicAddon[];
}

export type AdminAddonPrice = Omit<AddonPrice, "amount"> & {
  amount: number;
};

export type AdminAddon = Addon & {
  prices: AdminAddonPrice[];
};

export interface AdminAddonsResponse {
  addons: AdminAddon[];
}

export interface ResolvedBookingAddon {
  id: string;
  code: string;
  name: string;
  pricingUnit: AddonPricingUnit;
  financialTreatment: AddonFinancialTreatment;
  unitPrice: Decimal;
  quantity: number;
  totalPrice: Decimal;
}
