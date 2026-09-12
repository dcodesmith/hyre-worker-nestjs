import type { Prisma } from "@prisma/client";

export const DEFAULT_REFERRAL_ELIGIBLE_TYPES = ["DAY", "NIGHT", "FULL_DAY"] as const;

export type ReferralReleaseConditionValue = "PAID" | "COMPLETED";

/**
 * Typed referral program settings after the JSON key/value rows are parsed
 * once. Callers should not re-coerce the raw Prisma Json bag.
 *
 * `rewardAmount` uses REFERRAL_REWARD_AMOUNT, then REFERRAL_DISCOUNT_AMOUNT if
 * that key is present. It does not fall back to the discount default — a
 * missing pair means no reward is created.
 */
export interface ReferralProgramConfig {
  enabled: boolean;
  discountAmount: number;
  minBookingAmount: number;
  eligibleTypes: string[];
  releaseCondition: ReferralReleaseConditionValue;
  expiryDays: number;
  maxCreditsPerBooking: number;
  rewardAmount: number;
}

export type ReferralProgramConfigRow = {
  key: string;
  value: unknown;
};

type ReferralProgramConfigReader = Pick<
  Prisma.TransactionClient["referralProgramConfig"],
  "findMany"
>;

const DEFAULT_DISCOUNT_AMOUNT = 10000;
const DEFAULT_MIN_BOOKING_AMOUNT = 20000;
const DEFAULT_EXPIRY_DAYS = 30;
const DEFAULT_MAX_CREDITS_PER_BOOKING = 30000;

export function parseReferralProgramConfig(
  rows: readonly ReferralProgramConfigRow[],
): ReferralProgramConfig {
  const map = rows.reduce<Record<string, unknown>>((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});

  const rewardSource = map.REFERRAL_REWARD_AMOUNT ?? map.REFERRAL_DISCOUNT_AMOUNT;

  return {
    enabled: parseEnabled(map.REFERRAL_ENABLED ?? true),
    discountAmount: parseMoney(map.REFERRAL_DISCOUNT_AMOUNT, DEFAULT_DISCOUNT_AMOUNT),
    minBookingAmount: parseMoney(map.REFERRAL_MIN_BOOKING_AMOUNT, DEFAULT_MIN_BOOKING_AMOUNT),
    eligibleTypes: parseStringArray(map.REFERRAL_ELIGIBLE_TYPES, [
      ...DEFAULT_REFERRAL_ELIGIBLE_TYPES,
    ]),
    releaseCondition: map.REFERRAL_RELEASE_CONDITION === "PAID" ? "PAID" : "COMPLETED",
    expiryDays: parseFiniteNumber(
      map.REFERRAL_EXPIRY_DAYS ?? DEFAULT_EXPIRY_DAYS,
      DEFAULT_EXPIRY_DAYS,
    ),
    maxCreditsPerBooking: parseFiniteNumber(
      map.REFERRAL_MAX_CREDITS_PER_BOOKING ?? DEFAULT_MAX_CREDITS_PER_BOOKING,
      DEFAULT_MAX_CREDITS_PER_BOOKING,
    ),
    rewardAmount:
      rewardSource === undefined || rewardSource === null ? 0 : parseFiniteNumber(rewardSource, 0),
  };
}

export async function loadReferralProgramConfig(
  reader: ReferralProgramConfigReader,
): Promise<ReferralProgramConfig> {
  const rows = await reader.findMany();
  return parseReferralProgramConfig(rows);
}

function parseEnabled(raw: unknown): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    return raw.toLowerCase() === "true";
  }
  return false;
}

function parseMoney(raw: unknown, defaultIfMissing: number): number {
  if (raw === undefined || raw === null) {
    return defaultIfMissing;
  }
  return parseFiniteNumber(raw, 0);
}

function parseFiniteNumber(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function parseStringArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) {
    return fallback;
  }
  const strings = raw.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : fallback;
}
