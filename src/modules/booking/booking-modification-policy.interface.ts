import type { BookingStatus, PaymentStatus } from "@prisma/client";

export type BookingModificationPolicyInput = {
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  startDate: Date;
};

export type BookingModificationEligibility = {
  canEdit: boolean;
  canCancel: boolean;
  modificationCutoffAt: string;
  policyHoursBeforeStart: number;
};
