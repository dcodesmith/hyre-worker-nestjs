export type { ReferralProgramConfig as ReferralConfig } from "./referral-program-config";

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
  programEnabled: boolean;
  discountAmount: number;
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
