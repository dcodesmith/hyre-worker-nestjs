import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { BookingFetchFailedException, BookingNotFoundException } from "./booking.error";
import { BookingExtensionService } from "./booking-extension.service";
import { BookingModificationPolicyService } from "./booking-modification-policy.service";
import { hashBookingPaymentStatusToken } from "./booking-payment-status-token.helper";
import { BookingReadService } from "./booking-read.service";

describe("BookingReadService", () => {
  let service: BookingReadService;
  const policyNow = new Date("2026-08-01T23:59:59.999Z");
  const customerSessionUser = {
    id: "user-1",
    email: "user@example.com",
    name: "User One",
    emailVerified: true,
    image: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    roles: ["user" as const],
  };
  const fleetOwnerSessionUser = {
    id: "owner-1",
    email: "owner@example.com",
    name: "Owner One",
    emailVerified: true,
    image: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    roles: ["fleetOwner" as const],
  };
  const adminSessionUser = {
    id: "admin-1",
    email: "admin@example.com",
    name: "Admin One",
    emailVerified: true,
    image: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    roles: ["admin" as const],
  };
  const databaseServiceMock = {
    booking: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
  const bookingModificationPolicyServiceMock = {
    getEligibility: vi.fn((booking: { status: string }, canAct = true, _now?: Date) => {
      const canModify = canAct && booking.status === "CONFIRMED";
      return {
        canEdit: canModify,
        canCancel: canModify,
        modificationCutoffAt: "2026-08-02T00:00:00.000Z",
        policyHoursBeforeStart: 12,
      };
    }),
  };
  const bookingExtensionServiceMock = {
    getEligibilities: vi.fn(
      async (
        bookings: Array<{ id: string; legs?: Array<{ id: string }> }>,
        canAct: boolean,
        _now: Date,
      ) => {
        const results = new Map<string, { canExtend: boolean; maxExtendableHours: number }>();
        for (const booking of bookings) {
          for (const leg of booking.legs ?? []) {
            const eligible =
              canAct &&
              (booking.id === "booking-1" || booking.id === "booking-123") &&
              leg.id === "leg-1";
            results.set(leg.id, {
              canExtend: eligible,
              maxExtendableHours: eligible ? 3 : 0,
            });
          }
        }
        return results;
      },
    ),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    databaseServiceMock.$queryRaw.mockResolvedValue([{ policyNow }]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingReadService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        {
          provide: BookingModificationPolicyService,
          useValue: bookingModificationPolicyServiceMock,
        },
        {
          provide: BookingExtensionService,
          useValue: bookingExtensionServiceMock,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<BookingReadService>(BookingReadService);
  });

  it("groups current user bookings by status", async () => {
    const bookings = [
      {
        id: "booking-1",
        status: "CONFIRMED",
        totalAmount: { toNumber: () => 15000 },
        legs: [{ id: "leg-1" }, { id: "leg-future" }],
      },
      {
        id: "booking-2",
        status: "COMPLETED",
        totalAmount: { toNumber: () => 21000 },
        legs: [{ id: "leg-2" }],
      },
      {
        id: "booking-3",
        status: "CONFIRMED",
        totalAmount: { toNumber: () => 8000 },
        legs: [{ id: "leg-3" }],
      },
    ];
    databaseServiceMock.booking.findMany.mockResolvedValueOnce(bookings);

    const result = await service.getBookingsByStatus("user-1");

    expect(result).toEqual({
      CONFIRMED: [
        {
          id: "booking-1",
          status: "CONFIRMED",
          totalAmount: 15000,
          legs: [
            { id: "leg-1", canExtend: true, maxExtendableHours: 3 },
            { id: "leg-future", canExtend: false, maxExtendableHours: 0 },
          ],
          canEdit: true,
          canCancel: true,
          modificationCutoffAt: "2026-08-02T00:00:00.000Z",
          policyHoursBeforeStart: 12,
        },
        {
          id: "booking-3",
          status: "CONFIRMED",
          totalAmount: 8000,
          legs: [{ id: "leg-3", canExtend: false, maxExtendableHours: 0 }],
          canEdit: true,
          canCancel: true,
          modificationCutoffAt: "2026-08-02T00:00:00.000Z",
          policyHoursBeforeStart: 12,
        },
      ],
      COMPLETED: [
        {
          id: "booking-2",
          status: "COMPLETED",
          totalAmount: 21000,
          legs: [{ id: "leg-2", canExtend: false, maxExtendableHours: 0 }],
          canEdit: false,
          canCancel: false,
          modificationCutoffAt: "2026-08-02T00:00:00.000Z",
          policyHoursBeforeStart: 12,
        },
      ],
    });
    expect(bookingModificationPolicyServiceMock.getEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ id: "booking-1" }),
      true,
      policyNow,
    );
    expect(bookingExtensionServiceMock.getEligibilities).toHaveBeenCalledWith(
      bookings,
      true,
      policyNow,
    );
  });

  it("returns booking details with per-leg extension eligibility for the requesting user", async () => {
    const booking = {
      id: "booking-123",
      userId: "user-1",
      status: "CONFIRMED",
      totalAmount: { toNumber: () => 12000 },
      legs: [
        {
          id: "leg-1",
          extensions: [{ id: "ext-1", totalAmount: { toNumber: () => 2000 } }],
        },
        {
          id: "leg-past",
          extensions: [],
        },
      ],
    };
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce(booking);

    const result = await service.getBookingById("booking-123", customerSessionUser);

    expect(result).toEqual({
      id: "booking-123",
      userId: "user-1",
      status: "CONFIRMED",
      totalAmount: 12000,
      legs: [
        {
          id: "leg-1",
          extensions: [{ id: "ext-1", totalAmount: 2000 }],
          canExtend: true,
          maxExtendableHours: 3,
        },
        {
          id: "leg-past",
          extensions: [],
          canExtend: false,
          maxExtendableHours: 0,
        },
      ],
      canEdit: true,
      canCancel: true,
      modificationCutoffAt: "2026-08-02T00:00:00.000Z",
      policyHoursBeforeStart: 12,
    });
    expect(result).not.toHaveProperty("canExtend");
    expect(result).not.toHaveProperty("maxExtendableHours");
    expect(result).not.toHaveProperty("extensionBookingLegId");
    expect(bookingModificationPolicyServiceMock.getEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ id: "booking-123" }),
      true,
      policyNow,
    );
    expect(bookingExtensionServiceMock.getEligibilities).toHaveBeenCalledWith(
      [booking],
      true,
      policyNow,
    );
  });

  it("returns booking details for the fleet owner that owns the booked car", async () => {
    const booking = {
      id: "booking-123",
      userId: "user-2",
      status: "CONFIRMED",
      totalAmount: { toNumber: () => 12000 },
      car: {
        ownerId: "owner-1",
      },
      legs: [{ id: "leg-1" }],
    };
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce(booking);

    const result = await service.getBookingById("booking-123", fleetOwnerSessionUser);

    expect(result).toEqual({
      id: "booking-123",
      userId: "user-2",
      status: "CONFIRMED",
      totalAmount: 12000,
      car: {
        ownerId: "owner-1",
      },
      legs: [{ id: "leg-1", canExtend: false, maxExtendableHours: 0 }],
      canEdit: false,
      canCancel: false,
      modificationCutoffAt: "2026-08-02T00:00:00.000Z",
      policyHoursBeforeStart: 12,
    });
    expect(result).not.toHaveProperty("canExtend");
    expect(result).not.toHaveProperty("maxExtendableHours");
    expect(result).not.toHaveProperty("extensionBookingLegId");
    expect(databaseServiceMock.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "booking-123",
          OR: [{ car: { ownerId: "owner-1" } }],
        },
      }),
    );
    expect(bookingModificationPolicyServiceMock.getEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ id: "booking-123" }),
      false,
      policyNow,
    );
    expect(bookingExtensionServiceMock.getEligibilities).toHaveBeenCalledWith(
      [booking],
      false,
      policyNow,
    );
  });

  it("throws BookingNotFoundException when booking does not exist for customer", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.getBookingById("missing-booking", customerSessionUser),
    ).rejects.toBeInstanceOf(BookingNotFoundException);
  });

  it("returns the reservation expiry with payment status", async () => {
    const reservationExpiresAt = new Date("2099-08-02T20:10:00.000Z");
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-123",
      bookingReference: "BK-123",
      paymentIntent: "booking-123",
      paymentStatus: "UNPAID",
      paymentId: null,
      status: "PENDING",
      userId: "user-1",
      guestUser: null,
      totalAmount: { toNumber: () => 12000 },
      paymentSessionExpiresAt: reservationExpiresAt,
      paymentStatusTokenHash: null,
      customerPayments: [],
    });

    await expect(
      service.getBookingPaymentStatus(
        { bookingId: "booking-123", txRef: "booking-123" },
        customerSessionUser,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        bookingId: "booking-123",
        lifecycleState: "PENDING",
        reservationExpiresAt: reservationExpiresAt.toISOString(),
      }),
    );
  });

  it("returns VERIFYING when the unpaid reservation window has elapsed", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-123",
      bookingReference: "BK-123",
      paymentIntent: "booking-123",
      paymentStatus: "UNPAID",
      paymentId: null,
      status: "PENDING",
      userId: "user-1",
      guestUser: null,
      totalAmount: { toNumber: () => 12000 },
      paymentSessionExpiresAt: new Date(Date.now() - 1),
      paymentStatusTokenHash: null,
      customerPayments: [],
    });

    await expect(
      service.getBookingPaymentStatus(
        { bookingId: "booking-123", txRef: "booking-123" },
        customerSessionUser,
      ),
    ).resolves.toMatchObject({ lifecycleState: "VERIFYING" });
  });

  it("requires the opaque status token for guest payment status", async () => {
    const paymentStatusToken = "guest-payment-status-token";
    const guestBooking = {
      id: "booking-123",
      bookingReference: "BK-123",
      paymentIntent: "tx-ref-123",
      paymentStatus: "UNPAID",
      paymentId: null,
      status: "PENDING",
      userId: null,
      guestUser: { email: "guest@example.com" },
      totalAmount: { toNumber: () => 12000 },
      paymentSessionExpiresAt: new Date("2099-08-02T20:10:00.000Z"),
      paymentStatusTokenHash: hashBookingPaymentStatusToken(paymentStatusToken),
      customerPayments: [],
    };
    databaseServiceMock.booking.findFirst.mockResolvedValue(guestBooking);

    await expect(
      service.getBookingPaymentStatus(
        { bookingId: "booking-123", txRef: "tx-ref-123" },
        null,
        paymentStatusToken,
      ),
    ).resolves.toMatchObject({ lifecycleState: "PENDING" });

    await expect(
      service.getBookingPaymentStatus(
        { bookingId: "booking-123", txRef: "tx-ref-123" },
        customerSessionUser,
        paymentStatusToken,
      ),
    ).resolves.toMatchObject({ lifecycleState: "PENDING" });

    await expect(
      service.getBookingPaymentStatus(
        { bookingId: "booking-123", txRef: "tx-ref-123" },
        customerSessionUser,
        "wrong-token",
      ),
    ).rejects.toBeInstanceOf(BookingNotFoundException);

    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      ...guestBooking,
      paymentSessionExpiresAt: new Date("2020-08-02T20:10:00.000Z"),
    });
    await expect(
      service.getBookingPaymentStatus(
        { bookingId: "booking-123", txRef: "tx-ref-123" },
        null,
        paymentStatusToken,
      ),
    ).rejects.toBeInstanceOf(BookingNotFoundException);
  });

  it("returns terminal failed and expired payment lifecycle states", async () => {
    const baseBooking = {
      id: "booking-123",
      bookingReference: "BK-123",
      paymentIntent: "tx-ref-123",
      paymentStatus: "UNPAID",
      paymentId: null,
      userId: "user-1",
      guestUser: null,
      totalAmount: { toNumber: () => 12000 },
      paymentSessionExpiresAt: new Date("2099-08-02T20:10:00.000Z"),
      paymentStatusTokenHash: null,
    };
    databaseServiceMock.booking.findFirst
      .mockResolvedValueOnce({
        ...baseBooking,
        status: "PENDING",
        customerPayments: [{ status: "FAILED" }],
      })
      .mockResolvedValueOnce({
        ...baseBooking,
        status: "CANCELLED",
        customerPayments: [],
      });

    await expect(
      service.getBookingPaymentStatus(
        { bookingId: "booking-123", txRef: "tx-ref-123" },
        customerSessionUser,
      ),
    ).resolves.toMatchObject({ lifecycleState: "FAILED" });
    await expect(
      service.getBookingPaymentStatus(
        { bookingId: "booking-123", txRef: "tx-ref-123" },
        customerSessionUser,
      ),
    ).resolves.toMatchObject({ lifecycleState: "EXPIRED" });
  });

  it("throws BookingNotFoundException when user has no supported booking access role", async () => {
    await expect(service.getBookingById("booking-123", adminSessionUser)).rejects.toBeInstanceOf(
      BookingNotFoundException,
    );
    expect(databaseServiceMock.booking.findFirst).not.toHaveBeenCalled();
  });

  it("throws BookingFetchFailedException when list query fails unexpectedly", async () => {
    databaseServiceMock.booking.findMany.mockRejectedValueOnce(new Error("DB down"));

    await expect(service.getBookingsByStatus("user-1")).rejects.toBeInstanceOf(
      BookingFetchFailedException,
    );
  });

  it("throws BookingFetchFailedException when detail query fails unexpectedly", async () => {
    databaseServiceMock.booking.findFirst.mockRejectedValueOnce(new Error("DB down"));

    await expect(service.getBookingById("booking-123", customerSessionUser)).rejects.toBeInstanceOf(
      BookingFetchFailedException,
    );
  });
});
