export const PLACES_THROTTLE_CONFIG = {
  name: "places-public",
  ttlMs: 60 * 1000,
  ttlSeconds: 60,
  limits: {
    autocomplete: 24,
    resolve: 12,
    validate: 10,
  },
} as const;

export type PlacesThrottleOperation = keyof typeof PLACES_THROTTLE_CONFIG.limits;
