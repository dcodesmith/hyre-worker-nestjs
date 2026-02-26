export const REFERRAL_THROTTLE_CONFIG = {
  name: "referral-validation",
  ttlMs: 60 * 60 * 1000,
  ttlSeconds: 60 * 60,
  userLimit: 20,
  ipLimit: 60,
} as const;
