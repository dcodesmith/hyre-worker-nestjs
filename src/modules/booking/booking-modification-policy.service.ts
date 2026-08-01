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

  getEligibility(
    booking: BookingModificationPolicyInput,
    canAct = true,
    now = new Date(),
  ): BookingModificationEligibility {
    const modificationCutoffAt = this.getModificationCutoffAt(booking.startDate);
    const isWindowOpen = now.getTime() < modificationCutoffAt.getTime();

    return {
      canEdit: canAct && booking.status === BookingStatus.CONFIRMED && isWindowOpen,
      canCancel:
        canAct &&
        booking.status === BookingStatus.CONFIRMED &&
        booking.paymentStatus === PaymentStatus.PAID &&
        isWindowOpen,
      modificationCutoffAt: modificationCutoffAt.toISOString(),
      policyHoursBeforeStart: this.cutoffHours,
    };
  }

  assertCanEdit(booking: BookingModificationPolicyInput, now = new Date()): void {
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BookingStatusNotModifiableException(
        "edit",
        "Only confirmed bookings can be edited",
      );
    }
    this.assertWithinWindow(booking.startDate, now);
  }

  assertCanCancel(booking: BookingModificationPolicyInput, now = new Date()): void {
    if (
      booking.status !== BookingStatus.CONFIRMED ||
      booking.paymentStatus !== PaymentStatus.PAID
    ) {
      throw new BookingStatusNotModifiableException(
        "cancel",
        "Only paid confirmed bookings can be cancelled",
      );
    }
    this.assertWithinWindow(booking.startDate, now);
  }

  assertWithinWindow(startDate: Date, now = new Date()): void {
    const modificationCutoffAt = this.getModificationCutoffAt(startDate);
    if (now.getTime() >= modificationCutoffAt.getTime()) {
      throw new BookingOutsideModificationWindowException(modificationCutoffAt, this.cutoffHours);
    }
  }

  private getModificationCutoffAt(startDate: Date): Date {
    // Date#getTime is an absolute UTC instant, independent of the server's local timezone.
    return new Date(startDate.getTime() - this.cutoffHours * 60 * 60 * 1000);
  }
}
