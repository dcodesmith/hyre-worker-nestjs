export interface ReferralJobData {
  bookingId: string;
  timestamp: string;
}

export const PROCESS_REFERRAL_COMPLETION = "process-referral-completion";

export interface ReferralConfig {
  REFERRAL_ENABLED: boolean;
  REFERRAL_DISCOUNT_AMOUNT: number;
  REFERRAL_MIN_BOOKING_AMOUNT: number;
  REFERRAL_ELIGIBLE_TYPES: string[];
  REFERRAL_RELEASE_CONDITION: "PAID" | "COMPLETED";
  REFERRAL_EXPIRY_DAYS: number;
  REFERRAL_MAX_CREDITS_PER_BOOKING: number;
}

export interface ReferralStatsResponse {
  totalReferrals: number;
  totalRewardsGranted: number;
  totalRewardsPending: number;
  lastReferralAt: Date | null;
  totalEarned: number;
  totalUsed: number;
  availableCredits: number;
  maxCreditsPerBooking: number;
}

export interface ReferralUserSummaryResponse {
  referralCode: string | null;
  shareLink: string | null;
  hasUsedDiscount: boolean;
  referredBy: string | null;
  signupDate: Date | null;
  stats: ReferralStatsResponse;
  referrals: Array<{
    id: string;
    name: string | null;
    email: string;
    createdAt: Date;
  }>;
  rewards: Array<{
    id: string;
    amount: number;
    status: string;
    createdAt: Date;
    processedAt: Date | null;
    refereeName: string;
  }>;
}

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export interface ReferralThrottleRequestContext {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  route?: { path?: string };
  method?: string;
  authSession?: {
    user?: {
      id?: string;
    };
  };
}
