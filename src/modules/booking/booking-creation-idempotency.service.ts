import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { BookingCreationIdempotencyState, BookingStatus, Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import {
  BOOKING_IDEMPOTENCY_PROCESSING_LEASE_MS,
  BOOKING_IDEMPOTENCY_RETENTION_MS,
  BOOKING_IDEMPOTENCY_RETRY_AFTER_SECONDS,
} from "./booking.const";
import {
  BookingCreationFailedException,
  BookingRequestInProgressException,
  IdempotencyKeyReusedException,
} from "./booking.error";
import type { CreateBookingResponse } from "./booking.interface";
import type { CreateBookingInput } from "./dto/create-booking.dto";
import { isGuestBooking } from "./dto/create-booking.dto";

export type BookingIdempotencyClaim =
  | { kind: "claimed"; id: string }
  | { kind: "replay"; response: CreateBookingResponse }
  | { kind: "resume"; id: string; bookingId: string };

@Injectable()
export class BookingCreationIdempotencyService {
  private static readonly bookingStatuses = new Set<string>(Object.values(BookingStatus));

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingCreationIdempotencyService.name);
  }

  getCustomerScope(input: CreateBookingInput, sessionUser: AuthSession["user"] | null): string {
    if (sessionUser) {
      return `user:${sessionUser.id}`;
    }

    if (!isGuestBooking(input)) {
      throw new BookingCreationFailedException("Guest email is required for idempotency.");
    }

    const emailHash = createHash("sha256")
      .update(input.guestEmail.trim().toLowerCase())
      .digest("hex");
    return `guest:${emailHash}`;
  }

  createRequestHash(input: CreateBookingInput, context?: Record<string, unknown>): string {
    const normalized = {
      ...input,
      expectedTotalAmount: new Decimal(input.expectedTotalAmount).toString(),
      ...(isGuestBooking(input) && { guestEmail: input.guestEmail.trim().toLowerCase() }),
      context: context ?? null,
    };

    return createHash("sha256")
      .update(JSON.stringify(this.canonicalize(normalized)))
      .digest("hex");
  }

  async claim(
    customerScope: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<BookingIdempotencyClaim> {
    try {
      const created = await this.databaseService.bookingCreationIdempotency.create({
        data: { customerScope, idempotencyKey, requestHash },
        select: { id: true },
      });
      return { kind: "claimed", id: created.id };
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
    }

    const existing = await this.databaseService.bookingCreationIdempotency.findUnique({
      where: { customerScope_idempotencyKey: { customerScope, idempotencyKey } },
    });
    if (!existing) {
      return this.claim(customerScope, idempotencyKey, requestHash);
    }
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyKeyReusedException();
    }
    if (existing.state === BookingCreationIdempotencyState.COMPLETED) {
      return { kind: "replay", response: this.parseResponse(existing.response) };
    }
    if (existing.response !== null) {
      return this.finalizeCheckpointedResponse(existing.id, existing.response);
    }

    const leaseExpired =
      existing.updatedAt.getTime() <= Date.now() - BOOKING_IDEMPOTENCY_PROCESSING_LEASE_MS;
    if (!leaseExpired) {
      throw new BookingRequestInProgressException(BOOKING_IDEMPOTENCY_RETRY_AFTER_SECONDS);
    }

    if (existing.bookingId) {
      const claimed = await this.databaseService.bookingCreationIdempotency.updateMany({
        where: {
          id: existing.id,
          state: BookingCreationIdempotencyState.PROCESSING,
          updatedAt: existing.updatedAt,
        },
        data: { updatedAt: new Date() },
      });
      if (claimed.count === 1) {
        return { kind: "resume", id: existing.id, bookingId: existing.bookingId };
      }
    } else {
      const released = await this.databaseService.bookingCreationIdempotency.deleteMany({
        where: {
          id: existing.id,
          bookingId: null,
          state: BookingCreationIdempotencyState.PROCESSING,
          updatedAt: existing.updatedAt,
        },
      });
      if (released.count === 1) {
        return this.claim(customerScope, idempotencyKey, requestHash);
      }
    }

    throw new BookingRequestInProgressException(BOOKING_IDEMPOTENCY_RETRY_AFTER_SECONDS);
  }

  private async finalizeCheckpointedResponse(
    idempotencyId: string,
    response: Prisma.JsonValue,
  ): Promise<BookingIdempotencyClaim> {
    const finalized = await this.databaseService.bookingCreationIdempotency.updateMany({
      where: {
        id: idempotencyId,
        state: BookingCreationIdempotencyState.PROCESSING,
        bookingId: { not: null },
      },
      data: { state: BookingCreationIdempotencyState.COMPLETED },
    });
    if (finalized.count === 1) {
      return { kind: "replay", response: this.parseResponse(response) };
    }
    throw new BookingRequestInProgressException(BOOKING_IDEMPOTENCY_RETRY_AFTER_SECONDS);
  }

  async attachBooking(
    tx: Prisma.TransactionClient,
    idempotencyId: string,
    bookingId: string,
  ): Promise<void> {
    const attached = await tx.bookingCreationIdempotency.updateMany({
      where: {
        id: idempotencyId,
        state: BookingCreationIdempotencyState.PROCESSING,
        bookingId: null,
      },
      data: { bookingId },
    });
    if (attached.count !== 1) {
      throw new BookingCreationFailedException("Booking idempotency claim was lost.");
    }
  }

  async checkpointPaymentResult(
    idempotencyId: string,
    bookingId: string,
    paymentIntentId: string,
    response: CreateBookingResponse,
  ): Promise<void> {
    await this.databaseService.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: bookingId },
        data: { paymentIntent: paymentIntentId },
      });
      const checkpointed = await tx.bookingCreationIdempotency.updateMany({
        where: {
          id: idempotencyId,
          bookingId,
          state: BookingCreationIdempotencyState.PROCESSING,
        },
        data: { response: response as unknown as Prisma.InputJsonValue },
      });
      if (checkpointed.count !== 1) {
        throw new BookingCreationFailedException("Booking payment checkpoint was lost.");
      }
    });
  }

  async complete(idempotencyId: string): Promise<void> {
    const completed = await this.databaseService.bookingCreationIdempotency.updateMany({
      where: {
        id: idempotencyId,
        state: BookingCreationIdempotencyState.PROCESSING,
      },
      data: { state: BookingCreationIdempotencyState.COMPLETED },
    });
    if (completed.count === 1) return;

    const existing = await this.databaseService.bookingCreationIdempotency.findUnique({
      where: { id: idempotencyId },
      select: { state: true, response: true },
    });
    if (
      existing?.state !== BookingCreationIdempotencyState.COMPLETED ||
      existing.response === null
    ) {
      throw new BookingCreationFailedException(
        "Booking payment checkpoint could not be completed.",
      );
    }
  }

  async release(idempotencyId: string): Promise<void> {
    await this.databaseService.bookingCreationIdempotency.deleteMany({
      where: {
        id: idempotencyId,
        bookingId: null,
        state: BookingCreationIdempotencyState.PROCESSING,
      },
    });
  }

  @Cron("0 3 * * *")
  async cleanupExpiredRecords(): Promise<number> {
    const result = await this.databaseService.bookingCreationIdempotency.deleteMany({
      where: {
        createdAt: { lt: new Date(Date.now() - BOOKING_IDEMPOTENCY_RETENTION_MS) },
        OR: [
          { state: BookingCreationIdempotencyState.COMPLETED },
          { state: BookingCreationIdempotencyState.PROCESSING, bookingId: null },
        ],
      },
    });
    if (result.count > 0) {
      this.logger.info({ count: result.count }, "Deleted expired booking idempotency records");
    }
    return result.count;
  }

  private parseResponse(value: Prisma.JsonValue | null): CreateBookingResponse {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof value.bookingId !== "string" ||
      typeof value.checkoutUrl !== "string" ||
      typeof value.totalAmount !== "number" ||
      value.currency !== "NGN" ||
      typeof value.bookingStatus !== "string" ||
      !this.isBookingStatus(value.bookingStatus)
    ) {
      throw new BookingCreationFailedException("Stored booking response is invalid.");
    }
    return {
      bookingId: value.bookingId,
      checkoutUrl: value.checkoutUrl,
      totalAmount: value.totalAmount,
      currency: value.currency,
      bookingStatus: value.bookingStatus,
    };
  }

  private isBookingStatus(value: string): value is BookingStatus {
    return BookingCreationIdempotencyService.bookingStatuses.has(value);
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }

  private canonicalize(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((item) => this.canonicalize(item));
    if (typeof value !== "object" || value === null) return value;

    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, this.canonicalize(item)]),
    );
  }
}
