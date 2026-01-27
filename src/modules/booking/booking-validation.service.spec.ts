import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import type { Booking, Car, User } from "@prisma/client";
import { BookingStatus, CarApprovalStatus, PaymentStatus, Status } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
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

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("validateDates", () => {
    it("should pass validation for valid future booking", () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);

      const dayAfterTomorrow = new Date(tomorrow);
      dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

      const result = service.validateDates({
        startDate: tomorrow,
        endDate: dayAfterTomorrow,
        bookingType: "DAY",
        pickupTime: "9 AM",
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail validation when end date is before start date", () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const result = service.validateDates({
        startDate: tomorrow,
        endDate: yesterday,
        bookingType: "DAY",
        pickupTime: "9 AM",
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "endDate",
        message: "End date must be on or after start date",
      });
    });

    it("should fail validation when booking start is in the past", () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const today = new Date();

      const result = service.validateDates({
        startDate: yesterday,
        endDate: today,
        bookingType: "DAY",
        pickupTime: "9 AM",
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "startDate",
        message: "Booking start time cannot be in the past",
      });
    });

    it("should fail validation for same-day DAY booking after 11 AM", () => {
      // Mock current time to be 11 AM or later
      vi.useFakeTimers();
      const now = new Date();
      now.setHours(11, 0, 0, 0);
      vi.setSystemTime(now);

      try {
        const result = service.validateDates({
          startDate: now,
          endDate: now,
          bookingType: "DAY",
          pickupTime: "1 PM",
        });

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: "startDate",
          message: "Same-day DAY bookings cannot be made at or after 11 AM",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("should pass validation for same-day DAY booking before 11 AM", () => {
      // Mock current time to be 9 AM
      vi.useFakeTimers();
      const now = new Date();
      now.setHours(9, 0, 0, 0);
      vi.setSystemTime(now);

      try {
        const laterToday = new Date(now);
        laterToday.setHours(14, 0, 0, 0);

        const result = service.validateDates({
          startDate: laterToday,
          endDate: laterToday,
          bookingType: "DAY",
          pickupTime: "1 PM",
        });

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should fail validation for airport pickup without 1-hour advance notice", () => {
      const now = new Date();
      const thirtyMinutesFromNow = new Date(now.getTime() + 30 * 60 * 1000);

      const result = service.validateDates({
        startDate: thirtyMinutesFromNow,
        endDate: thirtyMinutesFromNow,
        bookingType: "AIRPORT_PICKUP",
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "startDate",
        message: "Airport pickup bookings require at least 1 hour advance notice",
      });
    });

    it("should pass validation for airport pickup with sufficient advance notice", () => {
      const now = new Date();
      const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      const threeHoursFromNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);

      const result = service.validateDates({
        startDate: twoHoursFromNow,
        endDate: threeHoursFromNow,
        bookingType: "AIRPORT_PICKUP",
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should not apply same-day restriction to NIGHT bookings", () => {
      // Mock current time to be 2 PM
      vi.useFakeTimers();
      const now = new Date();
      now.setHours(14, 0, 0, 0);
      vi.setSystemTime(now);

      try {
        const laterToday = new Date(now);
        laterToday.setHours(23, 0, 0, 0);

        const result = service.validateDates({
          startDate: laterToday,
          endDate: laterToday,
          bookingType: "NIGHT",
        });

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("checkCarAvailability", () => {
    it("should pass when car exists, is approved, available, and no conflicting bookings", async () => {
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

      const result = await service.checkCarAvailability({
        carId: "car-123",
        startDate: tomorrow,
        endDate: dayAfterTomorrow,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail when car does not exist", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(null);

      const result = await service.checkCarAvailability({
        carId: "non-existent-car",
        startDate: new Date(),
        endDate: new Date(),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "carId",
        message: "Car not found",
      });
    });

    it("should fail when car approval status is PENDING", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.AVAILABLE,
          approvalStatus: CarApprovalStatus.PENDING,
        }),
      );

      const result = await service.checkCarAvailability({
        carId: "car-123",
        startDate: new Date(),
        endDate: new Date(),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "carId",
        message: "This vehicle is not available for booking",
      });
      // Should not check for conflicting bookings if car is not approved
      expect(databaseService.booking.findMany).not.toHaveBeenCalled();
    });

    it("should fail when car approval status is REJECTED", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.AVAILABLE,
          approvalStatus: CarApprovalStatus.REJECTED,
        }),
      );

      const result = await service.checkCarAvailability({
        carId: "car-123",
        startDate: new Date(),
        endDate: new Date(),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "carId",
        message: "This vehicle is not available for booking",
      });
      expect(databaseService.booking.findMany).not.toHaveBeenCalled();
    });

    it("should fail when car status is HOLD", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.HOLD,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );

      const result = await service.checkCarAvailability({
        carId: "car-123",
        startDate: new Date(),
        endDate: new Date(),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "carId",
        message: "This vehicle is temporarily unavailable",
      });
      expect(databaseService.booking.findMany).not.toHaveBeenCalled();
    });

    it("should fail when car status is IN_SERVICE", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.IN_SERVICE,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );

      const result = await service.checkCarAvailability({
        carId: "car-123",
        startDate: new Date(),
        endDate: new Date(),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "carId",
        message: "This vehicle is currently under maintenance",
      });
      expect(databaseService.booking.findMany).not.toHaveBeenCalled();
    });

    it("should fail when car status is BOOKED", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(
        mockCar({
          id: "car-123",
          status: Status.BOOKED,
          approvalStatus: CarApprovalStatus.APPROVED,
        }),
      );

      const result = await service.checkCarAvailability({
        carId: "car-123",
        startDate: new Date(),
        endDate: new Date(),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "carId",
        message: "This vehicle is currently booked",
      });
      expect(databaseService.booking.findMany).not.toHaveBeenCalled();
    });

    it("should fail when there are conflicting bookings", async () => {
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

      const result = await service.checkCarAvailability({
        carId: "car-123",
        startDate: new Date("2025-02-01T10:00:00Z"),
        endDate: new Date("2025-02-01T18:00:00Z"),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "carId",
        message:
          "Car is not available for the selected dates. Please choose different dates or another vehicle.",
      });
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

      const result = await service.checkCarAvailability({
        carId: "car-123",
        startDate: new Date(),
        endDate: new Date(),
        excludeBookingId: "booking-to-exclude",
      });

      expect(result.valid).toBe(true);
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
    it("should pass for authenticated user booking (no guest email)", async () => {
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

      const result = await service.validateGuestEmail(input);

      expect(result.valid).toBe(true);
      expect(databaseService.user.findUnique).not.toHaveBeenCalled();
    });

    it("should pass for guest booking with unregistered email", async () => {
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

      const result = await service.validateGuestEmail(input);

      expect(result.valid).toBe(true);
      expect(databaseService.user.findUnique).toHaveBeenCalledWith({
        where: { email: "newuser@example.com" },
        select: { id: true },
      });
    });

    it("should fail for guest booking with already registered email", async () => {
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

      const result = await service.validateGuestEmail(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "guestEmail",
        message: "This email is already registered. Please log in to make a booking.",
      });
    });
  });

  describe("validatePriceMatch", () => {
    it("should pass when no client total is provided", () => {
      const result = service.validatePriceMatch(undefined, new Decimal("10000"));

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should pass when prices match exactly", () => {
      const result = service.validatePriceMatch("10000", new Decimal("10000"));

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should pass when prices are within tolerance", () => {
      const result = service.validatePriceMatch("10000.005", new Decimal("10000"));

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail when prices differ significantly", () => {
      const result = service.validatePriceMatch("9000", new Decimal("10000"));

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "clientTotalAmount",
        message: "Price mismatch. Please refresh and try again.",
      });
    });

    it("should fail for invalid price format", () => {
      const result = service.validatePriceMatch("not-a-number", new Decimal("10000"));

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "clientTotalAmount",
        message: "Invalid price format",
      });
    });
  });

  describe("validateAll", () => {
    it("should throw BadRequestException when validation fails", async () => {
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

      await expect(service.validateAll(input)).rejects.toThrow(BadRequestException);
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

    it("should include price validation when serverTotal is provided", async () => {
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
        BadRequestException,
      );
    });

    it("should aggregate all validation errors", async () => {
      vi.mocked(databaseService.car.findUnique).mockResolvedValueOnce(null);
      vi.mocked(databaseService.user.findUnique).mockResolvedValueOnce(
        mockUser({ id: "existing-user" }),
      );

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const input: CreateGuestBookingDto = {
        carId: "non-existent-car",
        startDate: yesterday,
        endDate: yesterday,
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

      try {
        await service.validateAll(input);
        expect.fail("Should have thrown BadRequestException");
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const response = (error as BadRequestException).getResponse() as { errors: unknown[] };
        // Should have multiple errors: past date, car not found, guest email registered

        expect(response.errors.length).toBeGreaterThanOrEqual(3);
        const errorFields = response.errors.map((e: { field: string }) => e.field);
        expect(errorFields).toContain("startDate");
        expect(errorFields).toContain("carId");
        expect(errorFields).toContain("guestEmail");
      }
    });
  });
});
