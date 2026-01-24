export const PROCESS_PAYOUT_FOR_BOOKING = "process-payout-for-booking";

export interface PayoutJobData {
  bookingId: string;
  timestamp: string;
}

export interface PaymentStatusResponse {
  txRef: string;
  status: string;
  amountExpected: number;
  amountCharged: number | null;
  confirmedAt: Date | null;
  booking?: {
    id: string;
    status: string;
  };
  extension?: {
    id: string;
    status: string;
  };
}

export interface UserInfo {
  id: string;
  email: string;
  name: string | null;
}
