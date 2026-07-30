const SUCCESSFUL_REFUND_STATUSES = new Set([
  "completed-bank-transfer",
  "completed-momo",
  "completed-mpgs",
  "completed-offline",
  "completed-preauth",
]);

const PENDING_REFUND_STATUSES = new Set(["completed", "pending-momo", "processing"]);
const FAILED_REFUND_STATUSES = new Set(["failed", "cancelled", "rejected"]);

export type RefundProviderState = "SUCCEEDED" | "PENDING" | "FAILED" | "UNKNOWN";

export function classifyRefundProviderStatus(status: string): RefundProviderState {
  const normalizedStatus = status.trim().toLowerCase();
  if (SUCCESSFUL_REFUND_STATUSES.has(normalizedStatus)) {
    return "SUCCEEDED";
  }
  if (PENDING_REFUND_STATUSES.has(normalizedStatus)) {
    return "PENDING";
  }
  if (FAILED_REFUND_STATUSES.has(normalizedStatus)) {
    return "FAILED";
  }
  return "UNKNOWN";
}
