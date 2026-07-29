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
