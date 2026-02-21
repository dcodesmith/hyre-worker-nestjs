import { EffectiveWindowRate } from "./rates.interface";

const FAR_FUTURE_DATE_ISO = "9999-12-31T00:00:00.000Z";

export function buildActiveWindowWhere(at: Date) {
  return {
    effectiveSince: { lte: at },
    OR: [{ effectiveUntil: { gt: at } }, { effectiveUntil: null }],
  };
}

export function buildOverlapWindowWhere(effectiveSince: Date, effectiveUntil?: Date) {
  return {
    effectiveSince: { lt: effectiveUntil ?? new Date(FAR_FUTURE_DATE_ISO) },
    OR: [{ effectiveUntil: { gt: effectiveSince } }, { effectiveUntil: null }],
  };
}

export function isRateActive(rate: EffectiveWindowRate, at: Date): boolean {
  return rate.effectiveSince <= at && (rate.effectiveUntil === null || rate.effectiveUntil > at);
}
