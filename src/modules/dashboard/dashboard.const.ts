export const DASHBOARD_RANGE_VALUES = ["7d", "30d", "90d", "custom"] as const;
export const DASHBOARD_GROUP_BY_VALUES = ["day", "week", "month"] as const;

export const DASHBOARD_DEFAULT_RANGE = "30d" as const;
export const DASHBOARD_DEFAULT_GROUP_BY = "day" as const;
export const DASHBOARD_DEFAULT_PAYOUT_PAGE = 1;
export const DASHBOARD_DEFAULT_PAYOUT_LIMIT = 20;
export const DASHBOARD_MAX_PAYOUT_LIMIT = 100;

export const DASHBOARD_RANGE_DAYS: Record<
  Exclude<(typeof DASHBOARD_RANGE_VALUES)[number], "custom">,
  number
> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
