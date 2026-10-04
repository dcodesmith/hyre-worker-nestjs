UPDATE "Booking"
SET
  "status" = 'EXPIRED',
  "cancelledAt" = NULL,
  "cancellationReason" = NULL,
  "updatedAt" = timezone('UTC', clock_timestamp())
WHERE
  "status" = 'CANCELLED'
  AND "paymentStatus" = 'UNPAID'
  AND "cancellationReason" = 'Payment session expired';
