import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import type { EnvConfig } from "../../config/env.config";
import {
  BookingOutsideModificationWindowException,
  BookingStatusNotModifiableException,
} from "./booking.error";
import type {
  BookingModificationEligibility,
  BookingModificationPolicyInput,
} from "./booking-modification-policy.interface";

@Injectable()
export class BookingModificationPolicyService {
  private readonly cutoffHours: number;

  constructor(configService: ConfigService<EnvConfig, true>) {
    this.cutoffHours = configService.get("BOOKING_MODIFICATION_CUTOFF_HOURS", { infer: true });
  }

  getStartDateThreshold(now: Date): Date {
    return new Date(now.getTime() + this.cutoffHours * 60 * 60 * 1000);
  }

  getEligibility(
    booking: BookingModificationPolicyInput,
    canAct = true,
    now = new Date(),
  ): BookingModificationEligibility {
    const modificationCutoffAt = this.getModificationCutoffAt(booking.startDate);
    const isWindowOpen = this.isWithinWindow(booking.startDate, now);

    return {
      canEdit: canAct && this.isEditableStatus(booking) && isWindowOpen,
      canCancel: canAct && this.isCancellableStatus(booking) && isWindowOpen,
      modificationCutoffAt: modificationCutoffAt.toISOString(),
      policyHoursBeforeStart: this.cutoffHours,
    };
  }

  assertCanEdit(booking: BookingModificationPolicyInput, now = new Date()): void {
    this.assertEditableStatus(booking);
    this.assertWithinWindow(booking.startDate, now);
  }

  assertEditableStatus(booking: BookingModificationPolicyInput): void {
    if (!this.isEditableStatus(booking)) {
      throw new BookingStatusNotModifiableException(
        "edit",
        "Only confirmed bookings can be edited",
      );
    }
  }

  assertCanCancel(booking: BookingModificationPolicyInput, now = new Date()): void {
    this.assertCancellableStatus(booking);
    this.assertWithinWindow(booking.startDate, now);
  }

  assertCancellableStatus(booking: BookingModificationPolicyInput): void {
    if (!this.isCancellableStatus(booking)) {
      throw new BookingStatusNotModifiableException(
        "cancel",
        "Only paid confirmed bookings can be cancelled",
      );
    }
  }

  assertWithinWindow(startDate: Date, now = new Date()): void {
    if (!this.isWithinWindow(startDate, now)) {
      const modificationCutoffAt = this.getModificationCutoffAt(startDate);
      throw new BookingOutsideModificationWindowException(modificationCutoffAt, this.cutoffHours);
    }
  }

  private isEditableStatus(booking: BookingModificationPolicyInput): boolean {
    return booking.status === BookingStatus.CONFIRMED;
  }

  private isCancellableStatus(booking: BookingModificationPolicyInput): boolean {
    return (
      booking.status === BookingStatus.CONFIRMED && booking.paymentStatus === PaymentStatus.PAID
    );
  }

  private isWithinWindow(startDate: Date, now: Date): boolean {
    return now.getTime() < this.getModificationCutoffAt(startDate).getTime();
  }

  private getModificationCutoffAt(startDate: Date): Date {
    // Date#getTime is an absolute UTC instant, independent of the server's local timezone.
    return new Date(startDate.getTime() - this.cutoffHours * 60 * 60 * 1000);
  }
}
