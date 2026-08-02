import { Test, type TestingModule } from "@nestjs/testing";
import { BookingCreationIdempotencyState, BookingStatus, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { BookingRequestInProgressException, IdempotencyKeyReusedException } from "./booking.error";
import { BookingCreationIdempotencyService } from "./booking-creation-idempotency.service";
import type { CreateBookingDto } from "./dto/create-booking.dto";

const reservationExpiresAt = "2026-08-02T20:10:00.000Z";

const input = (expectedTotalAmount = "100.00"): CreateBookingDto => ({
  carId: "car-1",
  startDate: new Date("2026-08-10T07:00:00.000Z"),
  endDate: new Date("2026-08-10T19:00:00.000Z"),
  pickupAddress: "Lagos",
  bookingType: "DAY",
  pickupTime: "8 AM",
  sameLocation: true,
  includeSecurityDetail: false,
  requiresFullTank: false,
  useCredits: 0,
  expectedTotalAmount,
});

const record = (overrides: Record<string, unknown> = {}) => ({
  id: "idem-1",
  customerScope: "user:user-1",
  idempotencyKey: "request-key",
  requestHash: "hash-1",
  state: BookingCreationIdempotencyState.PROCESSING,
  bookingId: null,
  response: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("BookingCreationIdempotencyService", () => {
  let service: BookingCreationIdempotencyService;
  let databaseService: {
    bookingCreationIdempotency: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
    };
    booking: { update: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    databaseService = {
      bookingCreationIdempotency: {
        create: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(),
      },
      booking: { update: vi.fn() },
      $transaction: vi.fn(async (callback) => callback(databaseService)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingCreationIdempotencyService,
        { provide: DatabaseService, useValue: databaseService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();
    service = module.get(BookingCreationIdempotencyService);
  });

  it("normalizes equivalent decimal strings before hashing", () => {
    expect(service.createRequestHash(input("100.0"))).toBe(
      service.createRequestHash(input("100.00")),
    );
  });

  it("claims a new customer-scoped key", async () => {
    databaseService.bookingCreationIdempotency.create.mockResolvedValue({ id: "idem-1" });

    await expect(service.claim("user:user-1", "request-key", "hash-1")).resolves.toEqual({
      kind: "claimed",
      id: "idem-1",
    });
  });

  it("replays the completed response for an identical request", async () => {
    databaseService.bookingCreationIdempotency.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    databaseService.bookingCreationIdempotency.findUnique.mockResolvedValue(
      record({
        state: BookingCreationIdempotencyState.COMPLETED,
        bookingId: "booking-1",
        response: {
          bookingId: "booking-1",
          checkoutUrl: "https://checkout.example/1",
          totalAmount: 100,
          currency: "NGN",
          bookingStatus: BookingStatus.PENDING,
          reservationExpiresAt,
        },
      }),
    );

    const result = await service.claim("user:user-1", "request-key", "hash-1");
    expect(result).toEqual({
      kind: "replay",
      response: expect.objectContaining({ bookingId: "booking-1", totalAmount: 100 }),
    });
  });

  it("finalizes and replays a checkpointed provider response", async () => {
    databaseService.bookingCreationIdempotency.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    databaseService.bookingCreationIdempotency.findUnique.mockResolvedValue(
      record({
        bookingId: "booking-1",
        response: {
          bookingId: "booking-1",
          checkoutUrl: "https://checkout.example/1",
          totalAmount: 100,
          currency: "NGN",
          bookingStatus: BookingStatus.PENDING,
          reservationExpiresAt,
        },
      }),
    );
    databaseService.bookingCreationIdempotency.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.claim("user:user-1", "request-key", "hash-1")).resolves.toEqual({
      kind: "replay",
      response: expect.objectContaining({ bookingId: "booking-1" }),
    });
  });

  it("rejects the same key for a different normalized request", async () => {
    databaseService.bookingCreationIdempotency.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    databaseService.bookingCreationIdempotency.findUnique.mockResolvedValue(record());

    await expect(service.claim("user:user-1", "request-key", "different-hash")).rejects.toThrow(
      IdempotencyKeyReusedException,
    );
  });

  it("returns an in-progress conflict while the processing lease is active", async () => {
    databaseService.bookingCreationIdempotency.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    databaseService.bookingCreationIdempotency.findUnique.mockResolvedValue(record());

    await expect(service.claim("user:user-1", "request-key", "hash-1")).rejects.toThrow(
      BookingRequestInProgressException,
    );
  });

  it("resumes the original booking after an abandoned processing lease", async () => {
    databaseService.bookingCreationIdempotency.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    databaseService.bookingCreationIdempotency.findUnique.mockResolvedValue(
      record({
        bookingId: "booking-1",
        updatedAt: new Date(Date.now() - 61_000),
      }),
    );
    databaseService.bookingCreationIdempotency.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.claim("user:user-1", "request-key", "hash-1")).resolves.toEqual({
      kind: "resume",
      id: "idem-1",
      bookingId: "booking-1",
    });
  });

  it("reclaims an abandoned pre-booking request", async () => {
    databaseService.bookingCreationIdempotency.create
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("duplicate", {
          code: "P2002",
          clientVersion: "test",
        }),
      )
      .mockResolvedValueOnce({ id: "idem-2" });
    databaseService.bookingCreationIdempotency.findUnique.mockResolvedValue(
      record({ updatedAt: new Date(Date.now() - 61_000) }),
    );
    databaseService.bookingCreationIdempotency.deleteMany.mockResolvedValue({ count: 1 });

    await expect(service.claim("user:user-1", "request-key", "hash-1")).resolves.toEqual({
      kind: "claimed",
      id: "idem-2",
    });
  });

  it("releases only a processing claim without a booking", async () => {
    databaseService.bookingCreationIdempotency.deleteMany.mockResolvedValue({ count: 1 });

    await service.release("idem-1");

    expect(databaseService.bookingCreationIdempotency.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "idem-1",
        bookingId: null,
        state: BookingCreationIdempotencyState.PROCESSING,
      },
    });
  });

  it("checkpoints the provider response before marking the request completed", async () => {
    databaseService.bookingCreationIdempotency.updateMany.mockResolvedValue({ count: 1 });

    await service.checkpointPaymentResult(
      "idem-1",
      "booking-1",
      "booking-1",
      new Date(reservationExpiresAt),
      {
        bookingId: "booking-1",
        checkoutUrl: "https://checkout.example/1",
        totalAmount: 100,
        currency: "NGN",
        bookingStatus: BookingStatus.PENDING,
        reservationExpiresAt,
      },
    );

    expect(databaseService.booking.update).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: {
        paymentIntent: "booking-1",
        paymentSessionExpiresAt: new Date(reservationExpiresAt),
      },
    });
    expect(databaseService.bookingCreationIdempotency.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "idem-1",
          bookingId: "booking-1",
          state: BookingCreationIdempotencyState.PROCESSING,
        }),
      }),
    );
  });
});
