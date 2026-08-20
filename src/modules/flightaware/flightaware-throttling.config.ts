export const FLIGHT_SEARCH_THROTTLE_CONFIG = {
  name: "flight-search-public",
  ttlMs: 60 * 1000,
  ttlSeconds: 60,
  limit: 10,
} as const;
