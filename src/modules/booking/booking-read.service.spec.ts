import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { BookingFetchFailedException, BookingNotFoundException } from "./booking.error";
import { BookingReadService } from "./booking-read.service";

describe("BookingReadService", () => {
  let service: BookingReadService;
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
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [BookingReadService, { provide: DatabaseService, useValue: databaseServiceMock }],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<BookingReadService>(BookingReadService);
  });

  it("groups current user bookings by status", async () => {
    databaseServiceMock.booking.findMany.mockResolvedValueOnce([
      {
        id: "booking-1",
        status: "CONFIRMED",
        totalAmount: { toNumber: () => 15000 },
      },
      {
        id: "booking-2",
        status: "COMPLETED",
        totalAmount: { toNumber: () => 21000 },
      },
      {
        id: "booking-3",
        status: "CONFIRMED",
        totalAmount: { toNumber: () => 8000 },
      },
    ]);

    const result = await service.getBookingsByStatus("user-1");

    expect(result).toEqual({
      CONFIRMED: [
        { id: "booking-1", status: "CONFIRMED", totalAmount: 15000 },
        { id: "booking-3", status: "CONFIRMED", totalAmount: 8000 },
      ],
      COMPLETED: [{ id: "booking-2", status: "COMPLETED", totalAmount: 21000 }],
    });
  });

  it("returns booking details for the requesting user", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-123",
      userId: "user-1",
      status: "CONFIRMED",
      totalAmount: { toNumber: () => 12000 },
      legs: [
        {
          id: "leg-1",
          extensions: [{ id: "ext-1", totalAmount: { toNumber: () => 2000 } }],
        },
      ],
    });

    const result = await service.getBookingById("booking-123", customerSessionUser);

    expect(result).toEqual({
      id: "booking-123",
      userId: "user-1",
      status: "CONFIRMED",
      totalAmount: 12000,
      legs: [{ id: "leg-1", extensions: [{ id: "ext-1", totalAmount: 2000 }] }],
    });
  });

  it("returns booking details for the fleet owner that owns the booked car", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-123",
      userId: "user-2",
      status: "CONFIRMED",
      totalAmount: { toNumber: () => 12000 },
      car: {
        ownerId: "owner-1",
      },
    });

    const result = await service.getBookingById("booking-123", fleetOwnerSessionUser);

    expect(result).toEqual({
      id: "booking-123",
      userId: "user-2",
      status: "CONFIRMED",
      totalAmount: 12000,
      car: {
        ownerId: "owner-1",
      },
    });
    expect(databaseServiceMock.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "booking-123",
          OR: [{ car: { ownerId: "owner-1" } }],
        },
      }),
    );
  });

  it("throws BookingNotFoundException when booking does not exist for customer", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.getBookingById("missing-booking", customerSessionUser),
    ).rejects.toBeInstanceOf(BookingNotFoundException);
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
