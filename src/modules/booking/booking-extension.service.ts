import { UTCDate } from "@date-fns/utc";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  BookingStatus,
  BookingType,
  ExtensionEventType,
  PaymentStatus,
  type Prisma,
} from "@prisma/client";
import { addDays, addHours, differenceInHours, isSameDay, startOfDay } from "date-fns";
import Decimal from "decimal.js";
import { BOOKING_BUFFER_HOURS } from "../../shared/availability-buffer.helper";
import type { AuthSession } from "../auth/guards/session.guard";
import {
  DatabaseService,
  lockBookingLegRow,
  lockBookingRow,
  lockCarRow,
} from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { RatesService } from "../rates/rates.service";
import {
  BLOCKING_BOOKING_STATUSES,
  BOOKING_PAYMENT_SESSION_DURATION_MINUTES,
  BOOKING_PAYMENT_SESSION_DURATION_MS,
  EXTENSION_IDEMPOTENCY_RETRY_AFTER_SECONDS,
} from "./booking.const";
import {
  ExtensionAlreadyConfirmedException,
  ExtensionCreationFailedException,
  ExtensionPaymentPendingException,
  ExtensionPaymentSessionExpiredException,
  ExtensionRequestInProgressException,
  ExtensionStateChangedException,
} from "./booking.error";
import type { BookingLegExtensionEligibility, CreateExtensionResponse } from "./booking.interface";
import { getDatabaseNow } from "./booking-modification-policy.helper";
import { BookingReservationService } from "./booking-reservation.service";
import type { CreateExtensionBodyDto } from "./dto/create-extension.dto";
import { ExtensionCreationIdempotencyService } from "./extension-creation-idempotency.service";

type ExtensionEndState = {
  legEndTime: Date;
  extensions: Array<{
    extensionEndTime: Date;
    status: string;
    paymentStatus: PaymentStatus;
  }>;
};

type ExtensionEligibilityBooking = {
  id: string;
  carId: string;
  type: BookingType;
  status: BookingStatus;
  legs: Array<
    ExtensionEndState & {
      id: string;
      legDate: Date;
    }
  >;
};

type ExtensionCandidate = {
  bookingId: string;
  bookingLegId: string;
  carId: string;
  currentEnd: Date;
  dayEnd: Date;
};

@Injectable()
export class BookingExtensionService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly ratesService: RatesService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly idempotencyService: ExtensionCreationIdempotencyService,
    private readonly bookingReservationService: BookingReservationService,
  ) {}

  async getEligibilities(
    bookings: ExtensionEligibilityBooking[],
    canAct: boolean,
    now: Date,
  ): Promise<Map<string, BookingLegExtensionEligibility>> {
    return this.getEligibilitiesWithReader(bookings, canAct, now, this.databaseService);
  }

  private async getEligibilitiesWithReader(
    bookings: ExtensionEligibilityBooking[],
    canAct: boolean,
    now: Date,
    reader: Pick<Prisma.TransactionClient, "booking">,
  ): Promise<Map<string, BookingLegExtensionEligibility>> {
    const results = new Map<string, BookingLegExtensionEligibility>();
    for (const booking of bookings) {
      for (const leg of booking.legs) {
        results.set(leg.id, { canExtend: false, maxExtendableHours: 0 });
      }
    }

    if (!canAct) {
      return results;
    }

    const candidates = this.collectExtensionCandidates(bookings, now);
    if (candidates.length === 0) {
      return results;
    }

    const nextBookings = await reader.booking.findMany({
      where: {
        deletedAt: null,
        status: { in: [...BLOCKING_BOOKING_STATUSES] },
        OR: candidates.map(({ bookingId, carId, currentEnd, dayEnd }) => ({
          id: { not: bookingId },
          carId,
          startDate: {
            gte: currentEnd,
            lte: addHours(dayEnd, BOOKING_BUFFER_HOURS),
          },
        })),
      },
      select: {
        id: true,
        carId: true,
        startDate: true,
      },
      orderBy: { startDate: "asc" },
    });

    this.applyExtensionLimits(results, candidates, nextBookings);
    return results;
  }

  private collectExtensionCandidates(
    bookings: ExtensionEligibilityBooking[],
    now: Date,
  ): ExtensionCandidate[] {
    const candidates: ExtensionCandidate[] = [];
    const today = startOfDay(new UTCDate(now));

    for (const booking of bookings) {
      if (
        booking.type !== BookingType.DAY ||
        (booking.status !== BookingStatus.CONFIRMED && booking.status !== BookingStatus.ACTIVE)
      ) {
        continue;
      }

      for (const bookingLeg of booking.legs) {
        if (this.hasPendingUnpaidExtension(bookingLeg)) {
          continue;
        }
        const legDay = startOfDay(new UTCDate(bookingLeg.legDate));
        const currentEnd = this.getCurrentLegEnd(bookingLeg);
        const dayEnd = addDays(legDay, 1);
        if (legDay >= today && currentEnd > now && currentEnd < dayEnd) {
          candidates.push({
            bookingId: booking.id,
            bookingLegId: bookingLeg.id,
            carId: booking.carId,
            currentEnd,
            dayEnd,
          });
        }
      }
    }

    return candidates;
  }

  private applyExtensionLimits(
    results: Map<string, BookingLegExtensionEligibility>,
    candidates: ExtensionCandidate[],
    nextBookings: Array<{ id: string; carId: string; startDate: Date }>,
  ): void {
    for (const candidate of candidates) {
      const nextBooking = nextBookings.find(
        (booking) =>
          booking.carId === candidate.carId &&
          booking.id !== candidate.bookingId &&
          booking.startDate >= candidate.currentEnd,
      );
      const bookingBufferLimit = nextBooking
        ? addHours(nextBooking.startDate, -BOOKING_BUFFER_HOURS)
        : candidate.dayEnd;
      const latestEnd = new Date(
        Math.min(bookingBufferLimit.getTime(), candidate.dayEnd.getTime()),
      );
      const maxExtendableHours = Math.max(0, differenceInHours(latestEnd, candidate.currentEnd));

      results.set(candidate.bookingLegId, {
        canExtend: maxExtendableHours >= 1,
        maxExtendableHours,
      });
    }
  }

  async createExtension(
    bookingId: string,
    body: CreateExtensionBodyDto,
    user: AuthSession["user"],
    idempotencyKey: string,
  ): Promise<CreateExtensionResponse> {
    const booking = await this.databaseService.booking.findFirst({
      where: {
        id: bookingId,
        userId: user.id,
      },
      include: {
        legs: {
          include: {
            extensions: true,
          },
        },
      },
    });

    if (!booking) {
      throw new NotFoundException("Booking not found");
    }

    const now = await getDatabaseNow(this.databaseService);
    const customerScope = this.idempotencyService.getCustomerScope(user.id);
    const previouslyResolvedBookingLegId = body.bookingLegId
      ? null
      : await this.idempotencyService.findResolvedBookingLegId(customerScope, idempotencyKey);
    const resolvedBookingLegId =
      body.bookingLegId ??
      previouslyResolvedBookingLegId ??
      booking.legs.find((leg) => isSameDay(new UTCDate(leg.legDate), new UTCDate(now)))?.id;
    if (!resolvedBookingLegId) {
      throw new BadRequestException("Booking leg not found");
    }

    const requestHash = this.idempotencyService.createRequestHash({
      bookingId: booking.id,
      bookingLegId: resolvedBookingLegId,
      hours: body.hours,
      callbackUrl: body.callbackUrl,
    });
    const claim = await this.idempotencyService.claim(
      customerScope,
      idempotencyKey,
      requestHash,
      resolvedBookingLegId,
    );
    if (claim.kind === "replay") {
      return claim.response;
    }

    try {
      if (claim.kind === "resume") {
        return this.resumeExtensionPayment(
          claim.id,
          claim.extensionId,
          booking.id,
          resolvedBookingLegId,
          user,
        );
      }

      const bookingLeg = booking.legs.find((leg) => leg.id === resolvedBookingLegId);
      if (!bookingLeg) {
        throw new BadRequestException("Booking leg not found");
      }

      if (booking.status !== BookingStatus.CONFIRMED && booking.status !== BookingStatus.ACTIVE) {
        throw new NotFoundException("Confirmed or active booking not found");
      }

      if (booking.type !== BookingType.DAY) {
        throw new BadRequestException("Only DAY bookings can be extended");
      }

      const rates = await this.ratesService.getRates();
      const expectedExtensionStartTime = new UTCDate(this.getCurrentLegEnd(bookingLeg));
      const paymentIntentReference = this.idempotencyService.createPaymentIntentReference(claim.id);

      const extension = await this.databaseService.$transaction(async (tx) => {
        const carExists = await lockCarRow(tx, booking.carId);
        if (!carExists) {
          throw new BadRequestException("Booking car not found");
        }
        const bookingExists = await lockBookingRow(tx, booking.id);
        if (!bookingExists) {
          throw new NotFoundException("Booking not found");
        }
        const legExists = await lockBookingLegRow(tx, bookingLeg.id);
        if (!legExists) {
          throw new BadRequestException("Booking leg not found");
        }

        const freshBooking = await tx.booking.findUnique({
          where: { id: booking.id },
          select: {
            id: true,
            userId: true,
            carId: true,
            status: true,
            type: true,
            car: {
              select: {
                hourlyRate: true,
              },
            },
            legs: {
              where: { id: bookingLeg.id },
              select: {
                id: true,
                legDate: true,
                legEndTime: true,
                extensions: {
                  select: {
                    extensionEndTime: true,
                    status: true,
                    paymentStatus: true,
                  },
                },
              },
            },
          },
        });
        if (!freshBooking || freshBooking.userId !== user.id) {
          throw new NotFoundException("Booking not found");
        }
        if (
          freshBooking.status !== BookingStatus.CONFIRMED &&
          freshBooking.status !== BookingStatus.ACTIVE
        ) {
          throw new NotFoundException("Confirmed or active booking not found");
        }
        if (freshBooking.type !== BookingType.DAY) {
          throw new BadRequestException("Only DAY bookings can be extended");
        }

        const freshLeg = freshBooking.legs[0];
        if (!freshLeg) {
          throw new BadRequestException("Booking leg not found");
        }
        if (this.hasPendingUnpaidExtension(freshLeg)) {
          throw new ExtensionPaymentPendingException(bookingLeg.id);
        }

        const transactionNow = await getDatabaseNow(tx);
        const extensionStartTime = new UTCDate(this.getCurrentLegEnd(freshLeg));
        if (extensionStartTime.getTime() !== expectedExtensionStartTime.getTime()) {
          throw new ExtensionStateChangedException(bookingLeg.id);
        }

        const eligibility = (
          await this.getEligibilitiesWithReader([freshBooking], true, transactionNow, tx)
        ).get(bookingLeg.id);
        if (!eligibility?.canExtend) {
          throw new BadRequestException("Booking leg cannot be extended");
        }
        if (body.hours > eligibility.maxExtendableHours) {
          throw new BadRequestException(
            `Maximum extension is ${eligibility.maxExtendableHours} hour(s) for this leg`,
          );
        }

        const baseAmount = new Decimal(freshBooking.car.hourlyRate).mul(body.hours);
        const customerServiceFee = baseAmount
          .mul(new Decimal(rates.platformCustomerServiceFeeRatePercent))
          .div(100);
        const subTotal = baseAmount.add(customerServiceFee);
        const vatAmount = subTotal.mul(new Decimal(rates.vatRatePercent)).div(100);
        const totalAmount = subTotal.add(vatAmount);
        const fleetFee = baseAmount
          .mul(new Decimal(rates.platformFleetOwnerCommissionRatePercent))
          .div(100);
        const extensionEndTime = addHours(extensionStartTime, body.hours);
        const paymentSessionExpiresAt = new Date(
          transactionNow.getTime() + BOOKING_PAYMENT_SESSION_DURATION_MS,
        );

        const created = await tx.extension.create({
          data: {
            bookingLegId: bookingLeg.id,
            extensionStartTime,
            extensionEndTime,
            extendedDurationHours: body.hours,
            eventType: ExtensionEventType.HOURLY_ADDITION,
            status: "PENDING",
            paymentStatus: PaymentStatus.UNPAID,
            paymentSessionExpiresAt,
            totalAmount,
            netTotal: baseAmount,
            paymentIntent: paymentIntentReference,
            platformCustomerServiceFeeAmount: customerServiceFee,
            platformCustomerServiceFeeRatePercent: rates.platformCustomerServiceFeeRatePercent,
            subtotalBeforeVat: subTotal,
            vatAmount,
            vatRatePercent: rates.vatRatePercent,
            platformFleetOwnerCommissionAmount: fleetFee,
            platformFleetOwnerCommissionRatePercent: rates.platformFleetOwnerCommissionRatePercent,
            fleetOwnerPayoutAmountNet: baseAmount.sub(fleetFee),
          },
          select: { id: true },
        });
        await this.idempotencyService.attachExtension(tx, claim.id, created.id);
        await tx.booking.updateMany({
          where: {
            id: booking.id,
            endDate: { lt: extensionEndTime },
          },
          data: { endDate: extensionEndTime },
        });
        return { ...created, totalAmount };
      });

      return this.createPaymentAndCheckpoint(
        claim.id,
        extension,
        booking.id,
        bookingLeg.id,
        body.callbackUrl,
        user,
      );
    } catch (error) {
      await this.idempotencyService.release(claim.id);
      if (this.bookingReservationService.isOverlapConstraintViolation(error)) {
        throw new BadRequestException("Booking leg cannot be extended due to another booking");
      }
      throw error;
    }
  }

  private async resumeExtensionPayment(
    idempotencyId: string,
    extensionId: string,
    bookingId: string,
    bookingLegId: string,
    user: AuthSession["user"],
  ): Promise<never> {
    const extension = await this.databaseService.extension.findUnique({
      where: { id: extensionId },
      select: {
        id: true,
        paymentIntent: true,
        paymentSessionExpiresAt: true,
        paymentStatus: true,
        status: true,
        bookingLegId: true,
        bookingLeg: {
          select: {
            booking: { select: { id: true, status: true, userId: true } },
          },
        },
      },
    });
    if (
      extension?.bookingLeg.booking.id !== bookingId ||
      extension?.bookingLeg.booking.userId !== user.id ||
      extension?.bookingLegId !== bookingLegId
    ) {
      throw new ExtensionCreationFailedException("Idempotent extension could not be recovered.");
    }
    const expectedPaymentIntent =
      this.idempotencyService.createPaymentIntentReference(idempotencyId);
    if (extension.paymentIntent !== expectedPaymentIntent) {
      throw new ExtensionCreationFailedException(
        "Idempotent extension has an unexpected payment reference.",
      );
    }
    const isConfirmed =
      extension.status === "ACTIVE" && extension.paymentStatus === PaymentStatus.PAID;
    if (isConfirmed) {
      throw new ExtensionAlreadyConfirmedException();
    }

    const paymentSessionExpiresAt: Date | null = extension.paymentSessionExpiresAt;
    const isPayable =
      extension.status === "PENDING" &&
      extension.paymentStatus === PaymentStatus.UNPAID &&
      Boolean(paymentSessionExpiresAt && paymentSessionExpiresAt > new Date());
    const parentStatus = extension.bookingLeg.booking.status;
    const parentIsActive =
      parentStatus === BookingStatus.CONFIRMED || parentStatus === BookingStatus.ACTIVE;
    if (!parentIsActive || !isPayable) {
      throw new ExtensionPaymentSessionExpiredException();
    }

    throw new ExtensionRequestInProgressException(EXTENSION_IDEMPOTENCY_RETRY_AFTER_SECONDS);
  }

  private async createPaymentAndCheckpoint(
    idempotencyId: string,
    extension: { id: string; totalAmount: Decimal; paymentIntent?: string | null },
    bookingId: string,
    bookingLegId: string,
    callbackUrl: string,
    user: AuthSession["user"],
  ): Promise<CreateExtensionResponse> {
    const paymentIntentReference =
      extension.paymentIntent ??
      this.idempotencyService.createPaymentIntentReference(idempotencyId);
    const paymentIntent = await this.flutterwaveService.createPaymentIntent({
      amount: extension.totalAmount.toNumber(),
      customer: {
        email: user.email,
        name: user.name || undefined,
      },
      callbackUrl,
      sessionDurationMinutes: BOOKING_PAYMENT_SESSION_DURATION_MINUTES,
      transactionType: "booking_extension",
      metadata: {
        bookingId,
        bookingLegId,
        extensionId: extension.id,
        source: "booking_extension_endpoint",
      },
      idempotencyKey: paymentIntentReference,
    });
    const response = {
      extensionId: extension.id,
      paymentIntentId: paymentIntentReference,
      checkoutUrl: paymentIntent.checkoutUrl,
    };
    await this.idempotencyService.checkpointResponse(idempotencyId, extension.id, response);
    await this.idempotencyService.complete(idempotencyId);
    return response;
  }

  private hasPendingUnpaidExtension(bookingLeg: ExtensionEndState): boolean {
    return bookingLeg.extensions.some(
      (extension) =>
        extension.status === "PENDING" && extension.paymentStatus === PaymentStatus.UNPAID,
    );
  }

  private getCurrentLegEnd(bookingLeg: ExtensionEndState): Date {
    return bookingLeg.extensions.reduce(
      (currentEnd, extension) =>
        extension.status === "ACTIVE" &&
        extension.paymentStatus === PaymentStatus.PAID &&
        extension.extensionEndTime > currentEnd
          ? extension.extensionEndTime
          : currentEnd,
      bookingLeg.legEndTime,
    );
  }
}
