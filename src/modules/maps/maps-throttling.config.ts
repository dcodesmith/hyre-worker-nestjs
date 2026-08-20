export const TRIP_DURATION_THROTTLE_CONFIG = {
  name: "trip-duration-public",
  ttlMs: 60 * 1000,
  ttlSeconds: 60,
  limit: 12,
} as const;
