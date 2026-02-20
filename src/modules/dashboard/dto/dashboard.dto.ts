import { PayoutTransactionStatus } from "@prisma/client";
import { z } from "zod";
import {
  DASHBOARD_DEFAULT_GROUP_BY,
  DASHBOARD_DEFAULT_PAYOUT_LIMIT,
  DASHBOARD_DEFAULT_PAYOUT_PAGE,
  DASHBOARD_DEFAULT_RANGE,
  DASHBOARD_GROUP_BY_VALUES,
  DASHBOARD_MAX_PAYOUT_LIMIT,
  DASHBOARD_RANGE_VALUES,
} from "../dashboard.const";

export const dashboardEarningsQuerySchema = z.object({
  range: z.enum(DASHBOARD_RANGE_VALUES).default(DASHBOARD_DEFAULT_RANGE),
  groupBy: z.enum(DASHBOARD_GROUP_BY_VALUES).default(DASHBOARD_DEFAULT_GROUP_BY),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type DashboardEarningsQueryDto = z.infer<typeof dashboardEarningsQuerySchema>;

export const dashboardPayoutsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(DASHBOARD_DEFAULT_PAYOUT_PAGE),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(DASHBOARD_MAX_PAYOUT_LIMIT)
    .default(DASHBOARD_DEFAULT_PAYOUT_LIMIT),
  status: z.enum(PayoutTransactionStatus).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type DashboardPayoutsQueryDto = z.infer<typeof dashboardPayoutsQuerySchema>;
