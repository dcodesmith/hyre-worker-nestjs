import { UnauthorizedException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AuthService } from "../auth/auth.service";
import { OptionalSessionGuard } from "../auth/guards/optional-session.guard";
import { BookingController } from "./booking.controller";
import {
  BookingFetchFailedException,
  BookingNotFoundException,
  BookingValidationException,
} from "./booking.error";
import { BookingCancellationService } from "./booking-cancellation.service";
import { BookingCreationService } from "./booking-creation.service";
import { BookingExtensionService } from "./booking-extension.service";
import { BookingReadService } from "./booking-read.service";
import { BookingUpdateService } from "./booking-update.service";
import {
  type CreateBookingDto,
  type CreateBookingInput,
  type CreateGuestBookingDto,
  createBookingSchema,
  createGuestBookingSchema,
} from "./dto/create-booking.dto";

/**
 * Helper function to validate booking input (simulates the decorator behavior)
 */
function validateBookingInput(rawBody: unknown, isAuthenticated: boolean): CreateBookingInput {
  const schema = isAuthenticated ? createBookingSchema : createGuestBookingSchema;
  const pipe = new ZodValidationPipe(schema, {
    exceptionFactory: (errors) => new BookingValidationException(errors),
  });
  return pipe.transform(rawBody);
}

describe("BookingController", () => {
  let controller: BookingController;
  let bookingCreationService: BookingCreationService;
  let bookingExtensionService: BookingExtensionService;
  let bookingReadService: BookingReadService;
  let bookingUpdateService: BookingUpdateService;
  let bookingCancellationService: BookingCancellationService;

  const mockCreateBookingResponse = {
    bookingId: "booking-123",
    checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
  };
  const mockCreateExtensionResponse = {
    extensionId: "extension-123",
    paymentIntentId: "tx-ext-123",
    checkoutUrl: "https://checkout.flutterwave.com/pay/ext123",
  };
  const mockBookingsByStatus = {
    CONFIRMED: [{ id: "booking-1", status: "CONFIRMED" }],
    COMPLETED: [{ id: "booking-2", status: "COMPLETED" }],
  };
  const mockBookingDetail = {
    id: "booking-123",
    status: "CONFIRMED",
    userId: "user-123",
    carId: "car-123",
  };

  const mockSessionUser = {
    id: "user-123",
    email: "user@example.com",
    name: "Test User",
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: ["user" as const],
  };

  const createValidBookingDto = (): CreateBookingDto => ({
    carId: "car-123",
    startDate: new Date("2025-02-01T09:00:00Z"),
    endDate: new Date("2025-02-01T21:00:00Z"),
    pickupAddress: "123 Main St, Lagos",
    bookingType: "DAY",
    pickupTime: "9:00 AM",
    sameLocation: true,
    includeSecurityDetail: false,
    requiresFullTank: false,
    useCredits: 0,
  });

  const createValidGuestBookingDto = (): CreateGuestBookingDto => ({
    ...createValidBookingDto(),
    guestEmail: "guest@example.com",
    guestName: "Guest User",
    guestPhone: "08098765432",
  });

  beforeEach(async () => {
    const mockBookingCreationService = {
      createBooking: vi.fn().mockResolvedValue(mockCreateBookingResponse),
    };
    const mockBookingExtensionService = {
      createExtension: vi.fn().mockResolvedValue(mockCreateExtensionResponse),
    };
    const mockBookingReadService = {
      getBookingsByStatus: vi.fn().mockResolvedValue(mockBookingsByStatus),
      getBookingById: vi.fn().mockResolvedValue(mockBookingDetail),
    };
    const mockBookingUpdateService = {
      updateBooking: vi.fn().mockResolvedValue(mockBookingDetail),
    };
    const mockBookingCancellationService = {
      cancelBooking: vi.fn().mockResolvedValue({ ...mockBookingDetail, status: "CANCELLED" }),
    };

    const mockAuthService = {
      isInitialized: true,
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue(null),
        },
      },
      getUserRoles: vi.fn().mockResolvedValue(["user"]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BookingController],
      providers: [
        { provide: BookingCreationService, useValue: mockBookingCreationService },
        { provide: BookingExtensionService, useValue: mockBookingExtensionService },
        { provide: BookingReadService, useValue: mockBookingReadService },
        { provide: BookingUpdateService, useValue: mockBookingUpdateService },
        { provide: BookingCancellationService, useValue: mockBookingCancellationService },
        { provide: AuthService, useValue: mockAuthService },
        OptionalSessionGuard,
      ],
    }).compile();

    controller = module.get<BookingController>(BookingController);
    bookingCreationService = module.get<BookingCreationService>(BookingCreationService);
    bookingExtensionService = module.get<BookingExtensionService>(BookingExtensionService);
    bookingReadService = module.get<BookingReadService>(BookingReadService);
    bookingUpdateService = module.get<BookingUpdateService>(BookingUpdateService);
    bookingCancellationService = module.get<BookingCancellationService>(BookingCancellationService);
  });
  describe("createBooking", () => {
    describe("authenticated user", () => {
      it("should create a booking for authenticated user", async () => {
        const dto = createValidBookingDto();
        const validatedDto = validateBookingInput(dto, true);

        const result = await controller.createBooking(validatedDto, mockSessionUser);

        expect(result).toEqual(mockCreateBookingResponse);
        expect(bookingCreationService.createBooking).toHaveBeenCalledWith(
          expect.objectContaining({
            carId: "car-123",
            bookingType: "DAY",
          }),
          {
            id: "user-123",
            email: "user@example.com",
            name: "Test User",
            emailVerified: true,
            image: null,
            roles: ["user"],
            createdAt: expect.any(Date),
            updatedAt: expect.any(Date),
          },
        );
      });

      it("should throw BookingValidationException for invalid booking data", async () => {
        const invalidDto = {
          carId: "", // Invalid - empty
          startDate: new Date("2025-02-01"),
          endDate: new Date("2025-02-01"),
          pickupAddress: "123 Main St",
          bookingType: "DAY",
          // Missing pickupTime (required for DAY)
          sameLocation: true,
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(invalidDto, true)).toThrow(BookingValidationException);
      });

      it("should validate pickupTime is required for DAY bookings", async () => {
        const dto = {
          ...createValidBookingDto(),
          pickupTime: undefined, // Missing
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, true)).toThrow(BookingValidationException);
      });

      it("should validate flightNumber is required for AIRPORT_PICKUP bookings", async () => {
        const dto = {
          ...createValidBookingDto(),
          bookingType: "AIRPORT_PICKUP" as const,
          pickupTime: undefined,
          sameLocation: false,
          dropOffAddress: "456 Drop Off St",
          // Missing flightNumber
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, true)).toThrow(BookingValidationException);
      });
    });

    describe("guest user", () => {
      it("should create a booking for guest user", async () => {
        const dto = createValidGuestBookingDto();
        const validatedDto = validateBookingInput(dto, false);

        const result = await controller.createBooking(validatedDto, null);

        expect(result).toEqual(mockCreateBookingResponse);
        expect(bookingCreationService.createBooking).toHaveBeenCalledWith(
          expect.objectContaining({
            carId: "car-123",
            guestEmail: "guest@example.com",
            guestName: "Guest User",
            guestPhone: "08098765432",
          }),
          null,
        );
      });

      it("should throw BookingValidationException if guest fields are missing", async () => {
        const dto = createValidBookingDto(); // Missing guest fields

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, false)).toThrow(BookingValidationException);
      });

      it("should validate guest email format", async () => {
        const dto = {
          ...createValidGuestBookingDto(),
          guestEmail: "invalid-email", // Invalid format
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, false)).toThrow(BookingValidationException);
      });

      it("should validate guest name minimum length", async () => {
        const dto = {
          ...createValidGuestBookingDto(),
          guestName: "A", // Too short
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, false)).toThrow(BookingValidationException);
      });

      it("should validate guest phone minimum length", async () => {
        const dto = {
          ...createValidGuestBookingDto(),
          guestPhone: "123", // Too short
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, false)).toThrow(BookingValidationException);
      });
    });

    describe("validation", () => {
      it("should validate end date is after start date", async () => {
        const dto = {
          ...createValidBookingDto(),
          startDate: new Date("2025-02-02"),
          endDate: new Date("2025-02-01"), // Before start
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, true)).toThrow(BookingValidationException);
      });

      it("should validate dropOffAddress is required when sameLocation is false", async () => {
        const dto = {
          ...createValidBookingDto(),
          sameLocation: false,
          // Missing dropOffAddress
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, true)).toThrow(BookingValidationException);
      });

      it("should accept booking with different drop-off location", async () => {
        const dto = {
          ...createValidBookingDto(),
          sameLocation: false as const,
          dropOffAddress: "456 Other St, Lagos",
        };
        const validatedDto = validateBookingInput(dto, true);

        const result = await controller.createBooking(validatedDto, mockSessionUser);

        expect(result).toEqual(mockCreateBookingResponse);
        expect(bookingCreationService.createBooking).toHaveBeenCalledWith(
          expect.objectContaining({
            sameLocation: false,
            dropOffAddress: "456 Other St, Lagos",
          }),
          expect.any(Object),
        );
      });

      it("should validate AIRPORT_PICKUP requires sameLocation=false", async () => {
        const dto = {
          ...createValidBookingDto(),
          bookingType: "AIRPORT_PICKUP" as const,
          pickupTime: undefined,
          sameLocation: true, // Invalid for AIRPORT_PICKUP
          flightNumber: "BA74",
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, true)).toThrow(BookingValidationException);
      });
    });
  });

  describe("createExtension", () => {
    it("creates extension for authenticated user", async () => {
      const result = await controller.createExtension(
        "booking-123",
        {
          hours: 2,
          callbackUrl: "https://example.com/extension-payment-status",
        },
        mockSessionUser,
      );

      expect(result).toEqual(mockCreateExtensionResponse);
      expect(bookingExtensionService.createExtension).toHaveBeenCalledWith(
        "booking-123",
        {
          hours: 2,
          callbackUrl: "https://example.com/extension-payment-status",
        },
        mockSessionUser,
      );
    });

    it("rejects createExtension when session user is missing", async () => {
      for (const sessionUser of [null, undefined]) {
        await expect(
          controller.createExtension(
            "booking-123",
            {
              hours: 2,
              callbackUrl: "https://example.com/extension-payment-status",
            },
            sessionUser,
          ),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }
      expect(bookingExtensionService.createExtension).not.toHaveBeenCalled();
    });

    it("propagates service error for invalid booking id", async () => {
      vi.mocked(bookingExtensionService.createExtension).mockRejectedValueOnce(
        new Error("Invalid booking id"),
      );

      await expect(
        controller.createExtension(
          "booking-123",
          {
            hours: 2,
            callbackUrl: "https://example.com/extension-payment-status",
          },
          mockSessionUser,
        ),
      ).rejects.toThrow("Invalid booking id");

      expect(bookingExtensionService.createExtension).toHaveBeenCalledWith(
        "booking-123",
        {
          hours: 2,
          callbackUrl: "https://example.com/extension-payment-status",
        },
        mockSessionUser,
      );
    });
  });

  describe("getBookingsByStatus", () => {
    it("returns bookings grouped by status for authenticated user", async () => {
      const result = await controller.getBookingsByStatus(mockSessionUser);

      expect(result).toEqual(mockBookingsByStatus);
      expect(bookingReadService.getBookingsByStatus).toHaveBeenCalledWith("user-123");
    });

    it("propagates service errors", async () => {
      vi.mocked(bookingReadService.getBookingsByStatus).mockRejectedValueOnce(
        new BookingFetchFailedException(),
      );

      await expect(controller.getBookingsByStatus(mockSessionUser)).rejects.toBeInstanceOf(
        BookingFetchFailedException,
      );
    });
  });

  describe("getBookingById", () => {
    it("returns booking details for authenticated user", async () => {
      const result = await controller.getBookingById("booking-123", mockSessionUser);

      expect(result).toEqual(mockBookingDetail);
      expect(bookingReadService.getBookingById).toHaveBeenCalledWith("booking-123", "user-123");
    });

    it("propagates BookingNotFoundException when booking does not exist", async () => {
      vi.mocked(bookingReadService.getBookingById).mockRejectedValueOnce(
        new BookingNotFoundException(),
      );

      await expect(
        controller.getBookingById("nonexistent", mockSessionUser),
      ).rejects.toBeInstanceOf(BookingNotFoundException);
    });
  });

  describe("updateBooking", () => {
    it("updates booking for authenticated user", async () => {
      const updateBody = { pickupAddress: "456 New St, Lagos" };

      const result = await controller.updateBooking("booking-123", updateBody, mockSessionUser);

      expect(result).toEqual(mockBookingDetail);
      expect(bookingUpdateService.updateBooking).toHaveBeenCalledWith(
        "booking-123",
        "user-123",
        updateBody,
      );
    });

    it("updates booking pickup time", async () => {
      const updateBody = { pickupTime: "10:00 AM" };

      await controller.updateBooking("booking-123", updateBody, mockSessionUser);

      expect(bookingUpdateService.updateBooking).toHaveBeenCalledWith(
        "booking-123",
        "user-123",
        updateBody,
      );
    });

    it("updates booking drop-off address with sameLocation false", async () => {
      const updateBody = {
        sameLocation: false as const,
        dropOffAddress: "789 Drop Off Ave",
      };

      await controller.updateBooking("booking-123", updateBody, mockSessionUser);

      expect(bookingUpdateService.updateBooking).toHaveBeenCalledWith(
        "booking-123",
        "user-123",
        updateBody,
      );
    });

    it("propagates service errors", async () => {
      vi.mocked(bookingUpdateService.updateBooking).mockRejectedValueOnce(
        new BookingNotFoundException(),
      );

      await expect(
        controller.updateBooking("booking-123", { pickupAddress: "New" }, mockSessionUser),
      ).rejects.toBeInstanceOf(BookingNotFoundException);
    });
  });

  describe("cancelBooking", () => {
    it("cancels booking with provided reason", async () => {
      const result = await controller.cancelBooking(
        "booking-123",
        { reason: "Plans changed" },
        mockSessionUser,
      );

      expect(result).toEqual(expect.objectContaining({ status: "CANCELLED" }));
      expect(bookingCancellationService.cancelBooking).toHaveBeenCalledWith(
        "booking-123",
        "user-123",
        "Plans changed",
      );
    });

    it("uses default reason when none provided", async () => {
      await controller.cancelBooking("booking-123", {}, mockSessionUser);

      expect(bookingCancellationService.cancelBooking).toHaveBeenCalledWith(
        "booking-123",
        "user-123",
        "User requested cancellation",
      );
    });

    it("propagates service errors", async () => {
      vi.mocked(bookingCancellationService.cancelBooking).mockRejectedValueOnce(
        new BookingNotFoundException(),
      );

      await expect(
        controller.cancelBooking("booking-123", { reason: "test" }, mockSessionUser),
      ).rejects.toBeInstanceOf(BookingNotFoundException);
    });
  });
});
