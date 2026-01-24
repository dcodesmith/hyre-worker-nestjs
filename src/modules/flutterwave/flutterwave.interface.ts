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
  bookingReference: string;
}

export interface PayoutResponse {
  success: boolean;
  data: FlutterwaveTransferData | { message: string };
}

// Payment Intent Types
export interface CustomerInfo {
  email: string;
  name?: string;
  phoneNumber?: string;
}

export interface PaymentIntentOptions {
  amount: number;
  customer: CustomerInfo;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  callbackUrl: string;
  transactionType: "booking_creation" | "booking_extension";
}

export interface PaymentIntentResponse {
  paymentIntentId: string;
  checkoutUrl: string;
}

export interface FlutterwavePaymentLinkData {
  link: string;
}

// Refund Types
export interface RefundOptions {
  transactionId: string;
  amount: number;
  callbackUrl?: string;
  /** Idempotency key to prevent duplicate refunds on retry */
  idempotencyKey: string;
}

export interface RefundResponse {
  success: boolean;
  refundId?: number;
  amountRefunded?: number;
  status?: string;
  error?: string;
}

export interface FlutterwaveRefundData {
  id: number;
  account_id: number;
  tx_id: number;
  flw_ref: string;
  wallet_id: number;
  amount_refunded: number;
  status: string;
  destination: string;
  meta: Record<string, unknown>;
  created_at: string;
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

// Webhook Types
// @see https://developer.flutterwave.com/v3.0/docs/webhooks

/** Discriminated union for Flutterwave webhook payloads */
export type FlutterwaveWebhookPayload =
  | { event: "charge.completed"; data: FlutterwaveChargeData }
  | { event: "transfer.completed"; data: FlutterwaveTransferWebhookData }
  | { event: "refund.completed"; data: FlutterwaveRefundWebhookData };

/**
 * Customer data in webhook payloads
 */
export interface FlutterwaveCustomerData {
  id: number;
  name: string;
  phone_number: string | null;
  email: string;
  created_at: string;
}

/**
 * Data for charge.completed webhook event
 * @see https://developer.flutterwave.com/v3.0/docs/webhooks
 */
export interface FlutterwaveChargeData {
  id: number;
  tx_ref: string;
  flw_ref: string;
  device_fingerprint: string;
  amount: number;
  currency: string;
  charged_amount: number;
  app_fee: number;
  merchant_fee: number;
  processor_response: string;
  auth_model: string;
  ip: string;
  narration: string;
  status: string;
  payment_type: string;
  created_at: string;
  account_id: number;
  customer: FlutterwaveCustomerData;
  meta?: Record<string, unknown>;
}

/**
 * Data for transfer.completed webhook event
 * Uses same structure as FlutterwaveTransferData
 */
export type FlutterwaveTransferWebhookData = FlutterwaveTransferData;

/**
 * Data for refund.completed webhook event
 * @see https://developer.flutterwave.com/v3.0/docs/refunds
 */
export interface FlutterwaveRefundWebhookData {
  id: number;
  AmountRefunded: number;
  status: string;
  FlwRef: string;
  destination: string;
  comments: string;
  settlement_id: string;
  meta: string;
  createdAt: string;
  updatedAt: string;
  walletId: number;
  AccountId: number;
  TransactionId: number;
}
