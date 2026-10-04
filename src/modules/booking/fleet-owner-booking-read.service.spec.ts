import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, BookingType, ChauffeurApprovalStatus, PaymentStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { BLOCKING_BOOKING_STATUSES } from "./booking.const";
import { BookingFetchFailedException, BookingNotFoundException } from "./booking.error";
import { FleetOwnerBookingReadService } from "./fleet-owner-booking-read.service";

const startDate = new Date("2026-09-20T08:00:00.000Z");
const endDate = new Date("2026-09-20T20:00:00.000Z");
const bufferedStart = new Date("2026-09-20T06:00:00.000Z");
const bufferedEnd = new Date("2026-09-20T22:00:00.000Z");

const ownerScope = {
  deletedAt: null,
  paymentStatus: { not: PaymentStatus.UNPAID },
  car: { ownerId: "owner-1" },
};

const responseKeys = [
  "id",
  "bookingReference",
  "status",
  "type",
  "startDate",
  "endDate",
  "pickupLocation",
  "returnLocation",
  "specialRequests",
  "flightNumber",
  "customerName",
  "car",
  "chauffeur",
  "canAssignChauffeur",
];

const car = {
  id: "car-1",
  make: "Mercedes",
  model: "S-Class",
  year: 2024,
  registrationNumber: "ABC123",
};

function fleetBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    bookingReference: "HY-100",
    status: BookingStatus.CONFIRMED,
    paymentStatus: PaymentStatus.PAID,
    type: BookingType.DAY,
    startDate,
    endDate,
    pickupLocation: "Airport",
    returnLocation: "Hotel",
    specialRequests: null,
    flightNumber: "BA123",
    guestUser: null,
    user: { name: "Ada Lovelace" },
    car,
    chauffeur: null,
    ...overrides,
  };
}

function visibleBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    bookingReference: "HY-100",
    status: BookingStatus.CONFIRMED,
    type: BookingType.DAY,
    startDate,
    endDate,
    pickupLocation: "Airport",
    returnLocation: "Hotel",
    specialRequests: null,
    flightNumber: "BA123",
    customerName: "Ada Lovelace",
    car,
    chauffeur: null,
    canAssignChauffeur: true,
    ...overrides,
  };
}

describe("FleetOwnerBookingReadService", () => {
  let service: FleetOwnerBookingReadService;
  let logger: PinoLogger;

  const databaseServiceMock = {
    booking: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FleetOwnerBookingReadService,
        { provide: DatabaseService, useValue: databaseServiceMock },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(FleetOwnerBookingReadService);
    logger = module.get(PinoLogger);
  });

  describe("list", () => {
    it("returns the owner's bookings and hides unpaid bookings", async () => {
      databaseServiceMock.booking.findMany.mockResolvedValueOnce([fleetBooking()]);
      databaseServiceMock.booking.count.mockResolvedValueOnce(1);

      const result = await service.list("owner-1", { page: 1, limit: 20 });

      expect(databaseServiceMock.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: ownerScope,
          select: expect.objectContaining({
            user: { select: { name: true } },
          }),
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: 0,
          take: 20,
        }),
      );
      expect(databaseServiceMock.booking.count).toHaveBeenCalledWith({ where: ownerScope });
      expect(result).toEqual({
        items: [visibleBooking()],
        meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
      });
    });

    it("returns pagination metadata for the requested page", async () => {
      databaseServiceMock.booking.findMany.mockResolvedValueOnce([
        fleetBooking({ id: "booking-2" }),
      ]);
      databaseServiceMock.booking.count.mockResolvedValueOnce(25);

      const result = await service.list("owner-1", { page: 2, limit: 10 });

      expect(databaseServiceMock.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(result.meta).toEqual({ page: 2, limit: 10, total: 25, totalPages: 3 });
      expect(result.items).toHaveLength(1);

      databaseServiceMock.booking.findMany.mockResolvedValueOnce([]);
      databaseServiceMock.booking.count.mockResolvedValueOnce(0);

      const empty = await service.list("owner-1", { page: 1, limit: 20 });

      expect(empty).toEqual({
        items: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });

    it.each([
      {
        label: "customer name",
        user: {
          name: "  Ada Lovelace  ",
          email: "ada@example.com",
          phoneNumber: "+2348011111111",
        },
        guestUser: {
          name: "Guest",
          guestEmail: "guest@example.com",
          guestPhone: "08012345678",
        },
        customerName: "Ada Lovelace",
      },
      {
        label: "guest name",
        user: { name: "   ", email: "ada@example.com", phoneNumber: "+2348011111111" },
        guestUser: {
          name: "  Guest Person  ",
          guestEmail: "guest@example.com",
          guestPhone: "08012345678",
        },
        customerName: "Guest Person",
      },
      {
        label: "fallback name",
        user: null,
        guestUser: { guestEmail: "guest@example.com", guestPhone: "08012345678", name: "  " },
        customerName: "Customer",
      },
      {
        label: "non-object guest payload",
        user: null,
        guestUser: ["guest@example.com"],
        customerName: "Customer",
      },
      {
        label: "non-string guest name",
        user: null,
        guestUser: { name: 12, guestEmail: "guest@example.com" },
        customerName: "Customer",
      },
    ])(
      "maps $label and omits customer contact fields",
      async ({ user, guestUser, customerName }) => {
        databaseServiceMock.booking.findMany.mockResolvedValueOnce([
          fleetBooking({ user, guestUser }),
        ]);
        databaseServiceMock.booking.count.mockResolvedValueOnce(1);

        const result = await service.list("owner-1", { page: 1, limit: 20 });
        const item = result.items[0];

        expect(item?.customerName).toBe(customerName);
        expect(Object.keys(item ?? {})).toEqual(responseKeys);
        expect(JSON.stringify(result)).not.toContain("ada@example.com");
        expect(JSON.stringify(result)).not.toContain("guest@example.com");
        expect(JSON.stringify(result)).not.toContain("08012345678");
        expect(JSON.stringify(result)).not.toContain("+2348011111111");
      },
    );

    it("wraps unexpected list failures", async () => {
      databaseServiceMock.booking.findMany.mockRejectedValueOnce(new Error("db down"));
      databaseServiceMock.booking.count.mockResolvedValueOnce(0);

      await expect(service.list("owner-1", { page: 1, limit: 20 })).rejects.toBeInstanceOf(
        BookingFetchFailedException,
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: "owner-1", error: "db down" }),
        "Failed to fetch fleet-owner bookings",
      );
    });
  });

  describe("get", () => {
    it("returns an owner booking and hides unpaid bookings from detail", async () => {
      const row = fleetBooking({
        user: { name: "Ada Lovelace", email: "ada@example.com", phoneNumber: "+2348011111111" },
        guestUser: {
          name: "Guest",
          guestEmail: "guest@example.com",
          guestPhone: "08012345678",
        },
      });
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(row);
      databaseServiceMock.user.findMany.mockResolvedValueOnce([]);

      const result = await service.get("owner-1", "booking-1");

      expect(databaseServiceMock.booking.findFirst).toHaveBeenCalledWith({
        where: { id: "booking-1", ...ownerScope },
        select: expect.objectContaining({
          user: { select: { name: true } },
        }),
      });
      expect(result.booking).toEqual(visibleBooking());
      expect(Object.keys(result.booking)).toEqual(responseKeys);
      expect(JSON.stringify(result)).not.toContain("ada@example.com");
      expect(JSON.stringify(result)).not.toContain("guest@example.com");
      expect(JSON.stringify(result)).not.toContain("08012345678");
    });

    it("throws when the booking is unpaid, deleted, or owned by someone else", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(null);

      await expect(service.get("owner-1", "booking-1")).rejects.toBeInstanceOf(
        BookingNotFoundException,
      );
      expect(databaseServiceMock.user.findMany).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("includes an eligible owner-driver and excludes unavailable, unapproved, and disabled chauffeurs", async () => {
      const assignableChauffeurs = [
        { id: "chauffeur-1", name: "Amina", image: null, isOwnerDriver: false },
        { id: "owner-1", name: "Owner", image: null, isOwnerDriver: true },
      ];
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(fleetBooking());
      databaseServiceMock.user.findMany.mockResolvedValueOnce(assignableChauffeurs);

      const result = await service.get("owner-1", "booking-1");

      expect(databaseServiceMock.user.findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ fleetOwnerId: "owner-1" }, { id: "owner-1", isOwnerDriver: true }],
          chauffeurDisabledAt: null,
          bookingsAsChauffeur: {
            none: {
              id: { not: "booking-1" },
              deletedAt: null,
              status: { in: [...BLOCKING_BOOKING_STATUSES] },
              startDate: { lt: bufferedEnd },
              endDate: { gt: bufferedStart },
            },
          },
          chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
        },
        select: {
          id: true,
          name: true,
          image: true,
          isOwnerDriver: true,
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      expect(result.assignableChauffeurs).toEqual(assignableChauffeurs);
      expect(result.booking.canAssignChauffeur).toBe(true);
    });

    it.each([PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUND_FAILED])(
      "keeps chauffeur assignment available for %s bookings",
      async (paymentStatus) => {
        databaseServiceMock.booking.findFirst.mockResolvedValueOnce(
          fleetBooking({ paymentStatus }),
        );
        databaseServiceMock.user.findMany.mockResolvedValueOnce([]);

        const result = await service.get("owner-1", "booking-1");

        expect(result.booking.canAssignChauffeur).toBe(true);
        expect(databaseServiceMock.user.findMany).toHaveBeenCalledOnce();
      },
    );

    it.each([
      { status: BookingStatus.ACTIVE, paymentStatus: PaymentStatus.PAID },
      { status: BookingStatus.CONFIRMED, paymentStatus: PaymentStatus.REFUNDED },
      { status: BookingStatus.CONFIRMED, paymentStatus: PaymentStatus.REFUND_PROCESSING },
    ])(
      "returns no assignable chauffeurs for $status bookings in $paymentStatus",
      async (overrides) => {
        databaseServiceMock.booking.findFirst.mockResolvedValueOnce(fleetBooking(overrides));

        const result = await service.get("owner-1", "booking-1");

        expect(result.booking.canAssignChauffeur).toBe(false);
        expect(result.assignableChauffeurs).toEqual([]);
        expect(databaseServiceMock.user.findMany).not.toHaveBeenCalled();
      },
    );

    it("wraps unexpected detail failures", async () => {
      databaseServiceMock.booking.findFirst.mockRejectedValueOnce(new Error("db down"));

      await expect(service.get("owner-1", "booking-1")).rejects.toBeInstanceOf(
        BookingFetchFailedException,
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: "booking-1", ownerId: "owner-1", error: "db down" }),
        "Failed to fetch fleet-owner booking",
      );
    });
  });
});
