import { Test, TestingModule } from "@nestjs/testing";
import type { Booking, Car, User } from "@prisma/client";
import { BookingStatus, CarApprovalStatus, PaymentStatus, Status } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import {
  BookingValidationException,
  CarNotAvailableException,
  CarNotFoundException,
} from "./booking.error";
import { BookingValidationService } from "./booking-validation.service";
import type { CreateBookingDto, CreateGuestBookingDto } from "./dto/create-booking.dto";

// Helper to create partial mock data with type safety
const mockCar = (data: Partial<Car>) => data as Car;
const mockBooking = (data: Partial<Booking>) => data as Booking;
const mockUser = (data: Partial<User>) => data as User;

describe("BookingValidationService", () => {
  let service: BookingValidationService;
  let databaseService: DatabaseService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingValidationService,
        {
          provide: DatabaseService,
          useValue: {
            car: {
              findUnique: vi.fn(),
            },
            booking: {
              findMany: vi.fn(),
            },
            user: {
              findUnique: vi.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<BookingValidationService>(BookingValidationService);
    databaseService = module.get<DatabaseService>(DatabaseService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  describe("validateDates", () => {
    it("should not throw for valid future booking", () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);

      const dayAfterTomorrow = new Date(tomorrow);
      dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

      expect(() =>
        service.validateDates({
          startDate: tomorrow,
          endDate: dayAfterTomorrow,
          bookingType: "DAY",
        }),
      ).not.toThrow();
    });

    it("should throw BookingValidationException when end date is before start date", () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      expect(() =>
        service.validateDates({
          startDate: tomorrow,
          endDate: yesterday,
          bookingType: "DAY",
        }),
      ).toThrow(BookingValidationException);
    });

    it("should throw BookingValidationException when end date equals start date (zero-duration)", () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);

      expect(() =>
        service.validateDates({
          startDate: tomorrow,
          endDate: new Date(tomorrow), // Same time
          bookingType: "DAY",
        }),
      ).toThrow(BookingValidationException);
    });

    it("should throw BookingValidationException when booking start is in the past", () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const today = new Date();

      expect(() =>
        service.validateDates({
          startDate: yesterday,
          endDate: today,
          bookingType: "DAY",
        }),
      ).toThrow(BookingValidationException);
    });

    it("should throw BookingValidationException for same-day DAY booking after 11 AM", () => {
      // Mock current time to be 11 AM or later
      vi.useFakeTimers();
      const now = new Date();
      now.setHours(11, 0, 0, 0);
      vi.setSystemTime(now);

      const startDate = new Date(now);
      startDate.setHours(14, 0, 0, 0); // 2 PM same day

      const endDate = new Date(startDate);
      endDate.setHours(18, 0, 0, 0); // 6 PM same day

      expect(() =>
        service.validateDates({
          startDate,
          endDate,
          bookingType: "DAY",
        }),
      ).toThrow(BookingValidationException);

      vi.useRealTimers();
    });

    it("should not throw for same-day DAY booking before 11 AM", () => {
      // Mock current time to be 9 AM
      vi.useFakeTimers();
      const now = new Date();
      now.setHours(9, 0, 0, 0);
      vi.setSystemTime(now);

      const startDate = new Date(now);
      startDate.setHours(14, 0, 0, 0); // 2 PM same day

      const endDate = new Date(startDate);
      endDate.setHours(18, 0, 0, 0); // 6 PM same day

      expect(() =>
        service.validateDates({
          startDate,
          endDate,
          bookingType: "DAY",
        }),
      ).not.toThrow();

      vi.useRealTimers();
    });

    it("should throw BookingValidationException for airport pickup without 1-hour advance notice", () => {
      const now = new Date();
      const thirtyMinutesFromNow = new Date(now.getTime() + 30 * 60 * 1000);
      const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);

      expect(() =>
        service.validateDates({
          startDate: thirtyMinutesFromNow,
          endDate: twoHoursFromNow,
          bookingType: "AIRPORT_PICKUP",
        }),
      ).toThrow(BookingValidationException);
    });

    it("should not throw for airport pickup with sufficient advance notice", () => {
      const now = new Date();
      const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      const threeHoursFromNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);

      expect(() =>
        service.validateDates({
          startDate: twoHoursFromNow,
          endDate: threeHoursFromNow,
          bookingType: "AIRPORT_PICKUP",
        }),
      ).not.toThrow();
    });

    it("should not apply same-day restriction to NIGHT bookings", () => {
      // Mock current time to be 2 PM
      vi.useFakeTimers();
      const now = new Date();
      now.setHours(14, 0, 0, 0);
      vi.setSystemTime(now);

      const startDate = new Date(now);
      startDate.setHours(23, 0, 0, 0); // 11 PM same day

      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
      endDate.setHours(5, 0, 0, 0); // 5 AM next day

      expect(() =>
        service.validateDates({
          startDate,
          endDate,
          bookingType: "NIGHT",
        }),
      ).not.toThrow();

      vi.useRealTimers();
    });
  });

  describe("checkCarAvailability", () => {
    it("should not throw when car exists, is approved, available, and no conflicting bookings", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.AVAILABLE,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );
      vi.mocked(databaseService.booking.findMany).mockResolvedValueOnce([]);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const dayAfterTomorrow = new Date(tomorrow);
      dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

      await expect(
        service.checkCarAvailability({
          carId: "car-123",
          startDate: tomorrow,
          endDate: dayAfterTomorrow,
        }),
      ).resolves.toBeUndefined();
    });

    it("should throw CarNotFoundException when car does not exist", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(null);

      await expect(
        service.checkCarAvailability({
          carId: "non-existent-car",
          startDate: new Date(),
          endDate: new Date(),
        }),
      ).rejects.toThrow(CarNotFoundException);
    });

    it("should throw CarNotAvailableException when car approval status is PENDING", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.AVAILABLE,
          approvalStatus: CarApprovalStatus.PENDING,
        }),
      );

      await expect(
        service.checkCarAvailability({
          carId: "car-123",
          startDate: new Date(),
          endDate: new Date(),
        }),
      ).rejects.toThrow(CarNotAvailableException);

      // Should not check for conflicting bookings if car is not approved
      expect(databaseService.booking.findMany).not.toHaveBeenCalled();
    });

    it("should throw CarNotAvailableException when car approval status is REJECTED", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.AVAILABLE,
          approvalStatus: CarApprovalStatus.REJECTED,
        }),
      );

      await expect(
        service.checkCarAvailability({
          carId: "car-123",
          startDate: new Date(),
          endDate: new Date(),
        }),
      ).rejects.toThrow(CarNotAvailableException);

      expect(databaseService.booking.findMany).not.toHaveBeenCalled();
    });

    it("should throw CarNotAvailableException when car status is HOLD", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.HOLD,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );

      await expect(
        service.checkCarAvailability({
          carId: "car-123",
          startDate: new Date(),
          endDate: new Date(),
        }),
      ).rejects.toThrow(CarNotAvailableException);

      expect(databaseService.booking.findMany).not.toHaveBeenCalled();
    });

    it("should throw CarNotAvailableException when car status is IN_SERVICE", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.IN_SERVICE,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );

      await expect(
        service.checkCarAvailability({
          carId: "car-123",
          startDate: new Date(),
          endDate: new Date(),
        }),
      ).rejects.toThrow(CarNotAvailableException);

      expect(databaseService.booking.findMany).not.toHaveBeenCalled();
    });

    it("should throw CarNotAvailableException when car status is BOOKED", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.BOOKED,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );

      await expect(
        service.checkCarAvailability({
          carId: "car-123",
          startDate: new Date(),
          endDate: new Date(),
        }),
      ).rejects.toThrow(CarNotAvailableException);

      expect(databaseService.booking.findMany).not.toHaveBeenCalled();
    });

    it("should throw CarNotAvailableException when there are conflicting bookings", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.AVAILABLE,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );
      vi.mocked(databaseService.booking.findMany).mockResolvedValueOnce([
        mockBooking({
          id: "existing-booking",
          startDate: new Date("2025-02-01T09:00:00Z"),
          endDate: new Date("2025-02-01T21:00:00Z"),
          bookingReference: "BK-EXISTING",
        }),
      ]);

      await expect(
        service.checkCarAvailability({
          carId: "car-123",
          startDate: new Date("2025-02-01T10:00:00Z"),
          endDate: new Date("2025-02-01T18:00:00Z"),
        }),
      ).rejects.toThrow(CarNotAvailableException);
    });

    it("should exclude specified booking when checking availability", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.AVAILABLE,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );
      vi.mocked(databaseService.booking.findMany).mockResolvedValueOnce([]);

      await service.checkCarAvailability({
        carId: "car-123",
        startDate: new Date(),
        endDate: new Date(),
        excludeBookingId: "booking-to-exclude",
      });

      expect(databaseService.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { not: "booking-to-exclude" },
          }),
        }),
      );
    });

    it("should only check bookings with CONFIRMED/ACTIVE status and PAID payment", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.AVAILABLE,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );
      vi.mocked(databaseService.booking.findMany).mockResolvedValueOnce([]);

      await service.checkCarAvailability({
        carId: "car-123",
        startDate: new Date(),
        endDate: new Date(),
      });

      expect(databaseService.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            paymentStatus: PaymentStatus.PAID,
            status: { in: [BookingStatus.CONFIRMED, BookingStatus.ACTIVE] },
          }),
        }),
      );
    });

    it("should use strict inequality (lt/gt) to allow exactly 2-hour buffer gaps", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.AVAILABLE,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );
      vi.mocked(databaseService.booking.findMany).mockResolvedValueOnce([]);

      const startDate = new Date("2025-03-01T14:00:00Z");
      const endDate = new Date("2025-03-01T18:00:00Z");

      await service.checkCarAvailability({
        carId: "car-123",
        startDate,
        endDate,
      });

      // Verify strict inequality is used (lt/gt instead of lte/gte)
      // This allows bookings with exactly 2-hour buffer gap to coexist
      expect(databaseService.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            startDate: { lt: expect.any(Date) },
            endDate: { gt: expect.any(Date) },
          }),
        }),
      );
    });
  });

  describe("validateGuestEmail", () => {
    it("should not throw for authenticated user booking (no guest email)", async () => {
      const input: CreateBookingDto = {
        carId: "car-123",
        startDate: new Date(),
        endDate: new Date(),
        pickupAddress: "123 Main St",
        bookingType: "DAY",
        sameLocation: true,
        includeSecurityDetail: false,
        requiresFullTank: false,
        useCredits: 0,
      };

      await expect(service.validateGuestEmail(input)).resolves.toBeUndefined();
      expect(databaseService.user.findUnique).not.toHaveBeenCalled();
    });

    it("should not throw for guest booking with unregistered email", async () => {
      vi.mocked(databaseService.user.findUnique).mockResolvedValueOnce(null);

      const input: CreateGuestBookingDto = {
        carId: "car-123",
        startDate: new Date(),
        endDate: new Date(),
        pickupAddress: "123 Main St",
        bookingType: "DAY",
        sameLocation: true,
        includeSecurityDetail: false,
        requiresFullTank: false,
        useCredits: 0,
        guestEmail: "newuser@example.com",
        guestName: "John Doe",
        guestPhone: "1234567890",
      };

      await expect(service.validateGuestEmail(input)).resolves.toBeUndefined();
      expect(databaseService.user.findUnique).toHaveBeenCalledWith({
        where: { email: "newuser@example.com" },
        select: { id: true },
      });
    });

    it("should throw BookingValidationException for guest booking with already registered email", async () => {
      vi.mocked(databaseService.user.findUnique).mockResolvedValueOnce(
        mockUser({ id: "existing-user" }),
      );

      const input: CreateGuestBookingDto = {
        carId: "car-123",
        startDate: new Date(),
        endDate: new Date(),
        pickupAddress: "123 Main St",
        bookingType: "DAY",
        sameLocation: true,
        includeSecurityDetail: false,
        requiresFullTank: false,
        useCredits: 0,
        guestEmail: "existing@example.com",
        guestName: "John Doe",
        guestPhone: "1234567890",
      };

      await expect(service.validateGuestEmail(input)).rejects.toThrow(BookingValidationException);
    });
  });

  describe("validatePriceMatch", () => {
    it("should not throw when no client total is provided", () => {
      expect(() => service.validatePriceMatch(undefined, new Decimal("10000"))).not.toThrow();
    });

    it("should not throw when prices match exactly", () => {
      expect(() => service.validatePriceMatch("10000", new Decimal("10000"))).not.toThrow();
    });

    it("should not throw when prices are within tolerance", () => {
      expect(() => service.validatePriceMatch("10000.005", new Decimal("10000"))).not.toThrow();
    });

    it("should throw BookingValidationException when prices differ significantly", () => {
      expect(() => service.validatePriceMatch("9000", new Decimal("10000"))).toThrow(
        BookingValidationException,
      );
    });

    it("should throw BookingValidationException for invalid price format", () => {
      expect(() => service.validatePriceMatch("not-a-number", new Decimal("10000"))).toThrow(
        BookingValidationException,
      );
    });
  });

  describe("validateAll", () => {
    it("should throw BookingValidationException when date validation fails", async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const input: CreateBookingDto = {
        carId: "car-123",
        startDate: yesterday,
        endDate: yesterday,
        pickupAddress: "123 Main St",
        bookingType: "DAY",
        sameLocation: true,
        includeSecurityDetail: false,
        requiresFullTank: false,
        useCredits: 0,
      };

      await expect(service.validateAll(input)).rejects.toThrow(BookingValidationException);
    });

    it("should not throw when all validations pass", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.AVAILABLE,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );
      vi.mocked(databaseService.booking.findMany).mockResolvedValueOnce([]);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);

      const dayAfterTomorrow = new Date(tomorrow);
      dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

      const input: CreateBookingDto = {
        carId: "car-123",
        startDate: tomorrow,
        endDate: dayAfterTomorrow,
        pickupAddress: "123 Main St",
        bookingType: "DAY",
        pickupTime: "9 AM",
        sameLocation: true,
        includeSecurityDetail: false,
        requiresFullTank: false,
        useCredits: 0,
      };

      await expect(service.validateAll(input)).resolves.toBeUndefined();
    });

    it("should throw BookingValidationException when price validation fails", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.AVAILABLE,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );
      vi.mocked(databaseService.booking.findMany).mockResolvedValueOnce([]);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);

      const dayAfterTomorrow = new Date(tomorrow);
      dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

      const input: CreateBookingDto = {
        carId: "car-123",
        startDate: tomorrow,
        endDate: dayAfterTomorrow,
        pickupAddress: "123 Main St",
        bookingType: "DAY",
        pickupTime: "9 AM",
        sameLocation: true,
        includeSecurityDetail: false,
        requiresFullTank: false,
        useCredits: 0,
        clientTotalAmount: "5000", // Intentionally wrong
      };

      await expect(service.validateAll(input, new Decimal("10000"))).rejects.toThrow(
        BookingValidationException,
      );
    });

    it("should throw CarNotFoundException when car does not exist", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(null);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);

      const dayAfterTomorrow = new Date(tomorrow);
      dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

      const input: CreateBookingDto = {
        carId: "non-existent-car",
        startDate: tomorrow,
        endDate: dayAfterTomorrow,
        pickupAddress: "123 Main St",
        bookingType: "DAY",
        sameLocation: true,
        includeSecurityDetail: false,
        requiresFullTank: false,
        useCredits: 0,
      };

      await expect(service.validateAll(input)).rejects.toThrow(CarNotFoundException);
    });

    it("should throw BookingValidationException for guest with registered email", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.AVAILABLE,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );
      vi.mocked(databaseService.booking.findMany).mockResolvedValueOnce([]);
      vi.mocked(databaseService.user.findUnique).mockResolvedValueOnce(
        mockUser({ id: "existing-user" }),
      );

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);

      const dayAfterTomorrow = new Date(tomorrow);
      dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

      const input: CreateGuestBookingDto = {
        carId: "car-123",
        startDate: tomorrow,
        endDate: dayAfterTomorrow,
        pickupAddress: "123 Main St",
        bookingType: "DAY",
        sameLocation: true,
        includeSecurityDetail: false,
        requiresFullTank: false,
        useCredits: 0,
        guestEmail: "existing@example.com",
        guestName: "John Doe",
        guestPhone: "1234567890",
      };

      await expect(service.validateAll(input)).rejects.toThrow(BookingValidationException);
    });
  });
});
