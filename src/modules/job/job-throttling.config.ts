export const JOB_THROTTLE_CONFIG = {
  name: "manual-triggers",
  ttlMs: 60 * 60 * 1000,
  limit: 1,
} as const;
