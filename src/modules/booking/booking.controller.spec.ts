import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth/auth.service";
import { OptionalSessionGuard } from "../auth/guards/optional-session.guard";
import { BookingController } from "./booking.controller";
import { BookingValidationException } from "./booking.error";
import { BookingCreationService } from "./booking-creation.service";
import {
  type CreateBookingDto,
  type CreateBookingInput,
  type CreateGuestBookingDto,
  createBookingSchema,
  createGuestBookingSchema,
} from "./dto/create-booking.dto";
import { BookingZodValidationPipe } from "./pipes/zod-validation.pipe";

/**
 * Helper function to validate booking input (simulates the decorator behavior)
 */
function validateBookingInput(rawBody: unknown, isAuthenticated: boolean): CreateBookingInput {
  const schema = isAuthenticated ? createBookingSchema : createGuestBookingSchema;
  const pipe = new BookingZodValidationPipe(schema);
  return pipe.transform(rawBody);
}

describe("BookingController", () => {
  let controller: BookingController;
  let bookingCreationService: BookingCreationService;

  const mockCreateBookingResponse = {
    bookingId: "booking-123",
    checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
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
        { provide: AuthService, useValue: mockAuthService },
        OptionalSessionGuard,
      ],
    }).compile();

    controller = module.get<BookingController>(BookingController);
    bookingCreationService = module.get<BookingCreationService>(BookingCreationService);
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
});
