export interface FlutterwaveResponse<T = unknown> {
  status: string;
  message: string;
  data?: T;
}

export interface FlutterwaveErrorResponse {
  status: string;
  message: string;
  data?: {
    code?: string;
    message?: string;
  };
}

export interface FlutterwaveTransferData {
  id: number;
  account_number: string;
  bank_code: string;
  full_name: string;
  created_at: string;
  currency: string;
  debit_currency: string;
  amount: number;
  fee: number;
  status: string;
  reference: string;
  meta: Record<string, unknown>;
  narration: string;
  complete_message: string;
  requires_approval: number;
  is_approved: number;
  bank_name: string;
}

export interface FlutterwaveAccountVerificationData {
  account_number: string;
  account_name: string;
  bank_code: string;
}

export interface FlutterwaveConfig {
  secretKey: string;
  publicKey: string;
  baseUrl: string;
  webhookSecret: string;
  webhookUrl: string;
}

export interface BankDetails {
  bankCode: string;
  accountNumber: string;
  bankName?: string;
}

export interface PayoutRequest {
  bankDetails: BankDetails;
  amount: number;
  reference: string;
  bookingId: string;
}

export interface PayoutResponse {
  success: boolean;
  data: FlutterwaveTransferData | { message: string };
}

export class FlutterwaveError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly statusCode?: number,
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = "FlutterwaveError";
  }
}
