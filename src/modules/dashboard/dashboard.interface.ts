import type { PayoutTransactionStatus } from "@prisma/client";
import type { DASHBOARD_GROUP_BY_VALUES, DASHBOARD_RANGE_VALUES } from "./dashboard.const";

export type DashboardRange = (typeof DASHBOARD_RANGE_VALUES)[number];
export type DashboardGroupBy = (typeof DASHBOARD_GROUP_BY_VALUES)[number];

export interface EarningsBucket {
  bucketStart: string;
  gross: number;
  net: number;
  fees: number;
  refunds: number;
  rides: number;
}

export type PayoutStatusBreakdown = Record<
  PayoutTransactionStatus,
  {
    count: number;
    amountToPay: number;
    amountPaid: number;
  }
>;
