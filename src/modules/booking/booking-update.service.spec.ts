import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import {
  BookingNotFoundException,
  BookingUpdateFailedException,
  BookingUpdateNotAllowedException,
  BookingValidationException,
} from "./booking.error";
import { BookingUpdateService } from "./booking-update.service";
import { BookingValidationService } from "./booking-validation.service";

describe("BookingUpdateService", () => {
  let service: BookingUpdateService;

  const databaseServiceMock = {
    booking: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };

  const bookingValidationServiceMock = {
    validateDates: vi.fn(),
    checkCarAvailability: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingUpdateService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: BookingValidationService, useValue: bookingValidationServiceMock },
      ],
    }).compile();

    service = module.get<BookingUpdateService>(BookingUpdateService);
  });

  it("updates booking pickup location", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.CONFIRMED,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 36 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });
    databaseServiceMock.booking.update.mockResolvedValueOnce({ id: "booking-1" });

    await service.updateBooking("booking-1", "user-1", {
      pickupAddress: "New pickup",
    });

    expect(databaseServiceMock.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
        data: expect.objectContaining({
          pickupLocation: "New pickup",
        }),
      }),
    );
  });

  it("updates booking pickup time for DAY and checks availability", async () => {
    const startDate = new Date(Date.now() + 48 * 60 * 60 * 1000);
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.CONFIRMED,
      startDate,
      endDate: new Date(startDate.getTime() + 12 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });
    databaseServiceMock.booking.update.mockResolvedValueOnce({ id: "booking-1" });

    await service.updateBooking("booking-1", "user-1", {
      pickupTime: "10:30 AM",
    });

    expect(bookingValidationServiceMock.validateDates).toHaveBeenCalled();
    expect(bookingValidationServiceMock.checkCarAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        carId: "car-1",
        excludeBookingId: "booking-1",
      }),
    );
  });

  it("throws when booking does not exist for user", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.updateBooking("missing", "user-1", { pickupAddress: "New pickup" }),
    ).rejects.toBeInstanceOf(BookingNotFoundException);
  });

  it("throws when booking is not confirmed", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.COMPLETED,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 36 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupAddress: "New pickup" }),
    ).rejects.toBeInstanceOf(BookingUpdateNotAllowedException);
  });

  it("throws validation error for pickupTime on unsupported booking type", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "NIGHT",
      status: BookingStatus.CONFIRMED,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 36 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupTime: "10 AM" }),
    ).rejects.toBeInstanceOf(BookingValidationException);
  });

  it("throws booking update failed for unexpected errors", async () => {
    databaseServiceMock.booking.findFirst.mockRejectedValueOnce(new Error("DB unavailable"));

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupAddress: "New pickup" }),
    ).rejects.toBeInstanceOf(BookingUpdateFailedException);
  });

  it("returns current booking when no changes detected", async () => {
    const baseBooking = {
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.CONFIRMED,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 36 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    };
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce(baseBooking);
    databaseServiceMock.booking.findUnique.mockResolvedValueOnce({
      id: "booking-1",
      paymentStatus: PaymentStatus.PAID,
    });

    const result = await service.updateBooking("booking-1", "user-1", {
      pickupAddress: "Old pickup",
    });

    expect(databaseServiceMock.booking.update).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "booking-1", paymentStatus: PaymentStatus.PAID });
  });
});
