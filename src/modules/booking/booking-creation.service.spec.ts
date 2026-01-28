import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBookingFinancials, createCar } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import type { FlightValidationResult } from "../flightaware/flightaware.interface";
import { FlightAwareService } from "../flightaware/flightaware.service";
import { FlutterwaveError } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { MapsService } from "../maps/maps.service";
import {
  BookingValidationException,
  CarNotFoundException,
  FlightValidationException,
  PaymentIntentFailedException,
} from "./booking.error";
import type { BookingCreationInput, ValidationResult } from "./booking.interface";
import { BookingCalculationService } from "./booking-calculation.service";
import { BookingCreationService } from "./booking-creation.service";
import { BookingLegService } from "./booking-leg.service";
import { BookingValidationService } from "./booking-validation.service";
import type { CreateBookingDto, CreateGuestBookingDto } from "./dto/create-booking.dto";

// Helper to create valid booking input
const createBookingInput = (overrides: Partial<CreateBookingDto> = {}): CreateBookingDto => {
  const base = {
    carId: "car-123",
    startDate: new Date("2025-02-01T09:00:00Z"),
    endDate: new Date("2025-02-01T21:00:00Z"),
    pickupAddress: "Lagos Airport",
    bookingType: "DAY" as const,
    pickupTime: "9 AM",
    sameLocation: true as const,
    includeSecurityDetail: false,
    requiresFullTank: false,
    useCredits: 0,
  };
  return { ...base, ...overrides } as CreateBookingDto;
};

// Helper to create guest booking input
const createGuestBookingInput = (
  overrides: Partial<CreateGuestBookingDto> = {},
): CreateGuestBookingDto => {
  const base = {
    ...createBookingInput(),
    guestEmail: "guest@example.com",
    guestName: "Guest User",
    guestPhone: "08012345678",
  };
  return { ...base, ...overrides } as CreateGuestBookingDto;
};

// Helper to create user context
const createUserContext = (): BookingCreationInput["user"] => ({
  id: "user-123",
  email: "user@example.com",
  name: "Test User",
  phoneNumber: "08012345678",
  referredByUserId: null,
  referralDiscountUsed: false,
});

describe("BookingCreationService", () => {
  let service: BookingCreationService;
  let databaseService: DatabaseService;
  let validationService: BookingValidationService;
  let legService: BookingLegService;
  let calculationService: BookingCalculationService;
  let flutterwaveService: FlutterwaveService;
  let flightAwareService: FlightAwareService;
  let mapsService: MapsService;

  // Mock transaction function
  const mockTransaction = vi.fn();

  beforeEach(async () => {
    // Reset all mocks
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingCreationService,
        {
          provide: DatabaseService,
          useValue: {
            car: { findUnique: vi.fn() },
            booking: { create: vi.fn(), update: vi.fn() },
            flight: { upsert: vi.fn() },
            referralProgramConfig: { findMany: vi.fn(), findFirst: vi.fn() },
            referralReward: { create: vi.fn() },
            userReferralStats: { upsert: vi.fn() },
            $transaction: mockTransaction,
          },
        },
        {
          provide: BookingValidationService,
          useValue: {
            validateDates: vi.fn(),
            checkCarAvailability: vi.fn(),
            validateGuestEmail: vi.fn(),
            validatePriceMatch: vi.fn(),
          },
        },
        {
          provide: BookingLegService,
          useValue: {
            generateLegs: vi.fn(),
          },
        },
        {
          provide: BookingCalculationService,
          useValue: {
            calculateBookingCost: vi.fn(),
          },
        },
        {
          provide: FlutterwaveService,
          useValue: {
            createPaymentIntent: vi.fn(),
            getWebhookUrl: vi.fn(),
          },
        },
        {
          provide: FlightAwareService,
          useValue: {
            validateFlight: vi.fn(),
            getOrCreateFlightAlert: vi.fn(),
          },
        },
        {
          provide: MapsService,
          useValue: {
            calculateAirportTripDuration: vi.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<BookingCreationService>(BookingCreationService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    validationService = module.get<BookingValidationService>(BookingValidationService);
    legService = module.get<BookingLegService>(BookingLegService);
    calculationService = module.get<BookingCalculationService>(BookingCalculationService);
    flutterwaveService = module.get<FlutterwaveService>(FlutterwaveService);
    flightAwareService = module.get<FlightAwareService>(FlightAwareService);
    mapsService = module.get<MapsService>(MapsService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("createBooking", () => {
    // Setup common mocks for successful booking flow
    const setupSuccessfulMocks = () => {
      const validResult: ValidationResult = { valid: true, errors: [] };
      vi.mocked(validationService.validateDates).mockReturnValue(validResult);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(validResult);
      vi.mocked(validationService.validateGuestEmail).mockResolvedValue(validResult);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue(validResult);

      vi.mocked(databaseService.car.findUnique).mockResolvedValue(createCar());

      vi.mocked(legService.generateLegs).mockReturnValue([
        {
          legDate: new Date("2025-02-01T00:00:00Z"),
          legStartTime: new Date("2025-02-01T09:00:00Z"),
          legEndTime: new Date("2025-02-01T21:00:00Z"),
        },
      ]);

      vi.mocked(calculationService.calculateBookingCost).mockResolvedValue(
        createBookingFinancials(),
      );

      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([]);

      vi.mocked(flutterwaveService.getWebhookUrl).mockReturnValue(
        "https://api.example.com/api/payments/callback",
      );

      // Setup transaction mock to execute the callback
      mockTransaction.mockImplementation(async (callback) => {
        const mockTx = {
          flight: { upsert: vi.fn().mockResolvedValue({ id: "flight-123" }) },
          booking: {
            create: vi.fn().mockResolvedValue({
              id: "booking-123",
              bookingReference: "BK-123456-ABC",
              totalAmount: new Decimal(56437.5),
              status: BookingStatus.PENDING,
            }),
            update: vi.fn(),
          },
          referralProgramConfig: { findMany: vi.fn().mockResolvedValue([]) },
          referralReward: { create: vi.fn() },
          userReferralStats: { upsert: vi.fn() },
        };

        return callback(mockTx);
      });

      vi.mocked(flutterwaveService.createPaymentIntent).mockResolvedValue({
        paymentIntentId: "pi-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      });
    };

    it("should create a booking successfully for authenticated user", async () => {
      setupSuccessfulMocks();

      const booking = createBookingInput();
      const user = createUserContext();

      const result = await service.createBooking({ booking, user });

      expect(result).toEqual({
        bookingId: "booking-123",
        bookingReference: expect.stringMatching(/^BK-/),
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
        totalAmount: "56437.5",
        status: BookingStatus.PENDING,
      });

      expect(validationService.validateDates).toHaveBeenCalledWith({
        startDate: booking.startDate,
        endDate: booking.endDate,
        bookingType: booking.bookingType,
      });

      expect(validationService.checkCarAvailability).toHaveBeenCalledWith({
        carId: booking.carId,
        startDate: booking.startDate,
        endDate: booking.endDate,
      });

      expect(calculationService.calculateBookingCost).toHaveBeenCalled();
      expect(flutterwaveService.createPaymentIntent).toHaveBeenCalled();
    });

    it("should create a booking successfully for guest user", async () => {
      setupSuccessfulMocks();

      const booking = createGuestBookingInput();

      const result = await service.createBooking({ booking, user: null });

      expect(result).toEqual({
        bookingId: "booking-123",
        bookingReference: expect.stringMatching(/^BK-/),
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
        totalAmount: "56437.5",
        status: BookingStatus.PENDING,
      });

      expect(validationService.validateGuestEmail).toHaveBeenCalledWith(booking);
    });

    it("should throw BookingValidationException when date validation fails", async () => {
      vi.mocked(validationService.validateDates).mockReturnValue({
        valid: false,
        errors: [{ field: "startDate", message: "Start date cannot be in the past" }],
      });

      const booking = createBookingInput();
      const user = createUserContext();

      await expect(service.createBooking({ booking, user })).rejects.toThrow(
        BookingValidationException,
      );

      expect(validationService.checkCarAvailability).not.toHaveBeenCalled();
    });

    it("should throw BookingValidationException when car is not available", async () => {
      vi.mocked(validationService.validateDates).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue({
        valid: false,
        errors: [{ field: "carId", message: "Car is not available for the selected dates" }],
      });

      const booking = createBookingInput();
      const user = createUserContext();

      await expect(service.createBooking({ booking, user })).rejects.toThrow(
        BookingValidationException,
      );

      expect(databaseService.car.findUnique).not.toHaveBeenCalled();
    });

    it("should throw BookingValidationException when guest email is registered", async () => {
      vi.mocked(validationService.validateDates).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue({
        valid: true,
        errors: [],
      });
      vi.mocked(validationService.validateGuestEmail).mockResolvedValue({
        valid: false,
        errors: [{ field: "guestEmail", message: "This email is already registered" }],
      });

      const booking = createGuestBookingInput();

      await expect(service.createBooking({ booking, user: null })).rejects.toThrow(
        BookingValidationException,
      );
    });

    it("should throw CarNotFoundException when car does not exist", async () => {
      vi.mocked(validationService.validateDates).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue({
        valid: true,
        errors: [],
      });
      vi.mocked(databaseService.car.findUnique).mockResolvedValue(null);

      const booking = createBookingInput();
      const user = createUserContext();

      await expect(service.createBooking({ booking, user })).rejects.toThrow(CarNotFoundException);
    });

    it("should throw BookingValidationException when price does not match", async () => {
      vi.mocked(validationService.validateDates).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue({
        valid: true,
        errors: [],
      });
      vi.mocked(databaseService.car.findUnique).mockResolvedValue(createCar());
      vi.mocked(legService.generateLegs).mockReturnValue([
        {
          legDate: new Date("2025-02-01T00:00:00Z"),
          legStartTime: new Date("2025-02-01T09:00:00Z"),
          legEndTime: new Date("2025-02-01T21:00:00Z"),
        },
      ]);
      vi.mocked(calculationService.calculateBookingCost).mockResolvedValue(
        createBookingFinancials(),
      );
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([]);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue({
        valid: false,
        errors: [{ field: "clientTotalAmount", message: "Price mismatch" }],
      });

      const booking = createBookingInput({ clientTotalAmount: "10000" });
      const user = createUserContext();

      await expect(service.createBooking({ booking, user })).rejects.toThrow(
        BookingValidationException,
      );
    });

    it("should throw PaymentIntentFailedException when payment creation fails", async () => {
      setupSuccessfulMocks();

      // Override to throw FlutterwaveError
      mockTransaction.mockImplementation(async (callback) => {
        const mockTx = {
          flight: { upsert: vi.fn().mockResolvedValue({ id: "flight-123" }) },
          booking: {
            create: vi.fn().mockResolvedValue({
              id: "booking-123",
              bookingReference: "BK-123456-ABC",
              totalAmount: new Decimal(56437.5),
              status: BookingStatus.PENDING,
            }),
            update: vi.fn(),
          },
          referralProgramConfig: { findMany: vi.fn().mockResolvedValue([]) },
          referralReward: { create: vi.fn() },
          userReferralStats: { upsert: vi.fn() },
        };

        // This callback will call createPaymentIntent which we mock to throw
        vi.mocked(flutterwaveService.createPaymentIntent).mockRejectedValue(
          new FlutterwaveError("Payment failed", "PAYMENT_FAILED"),
        );

        return callback(mockTx);
      });

      const booking = createBookingInput();
      const user = createUserContext();

      await expect(service.createBooking({ booking, user })).rejects.toThrow(
        PaymentIntentFailedException,
      );
    });
  });

  describe("createBooking - Airport Pickup", () => {
    it("should validate flight for airport pickup bookings", async () => {
      const validResult: ValidationResult = { valid: true, errors: [] };
      vi.mocked(validationService.validateDates).mockReturnValue(validResult);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(validResult);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue(validResult);

      const flightValidationResult: FlightValidationResult = {
        type: "success",
        flight: {
          flightNumber: "BA74",
          flightId: "BA74-20250201",
          origin: "EGLL",
          originIATA: "LHR",
          destination: "DNMM",
          destinationIATA: "LOS",
          scheduledArrival: "2025-02-01T14:30:00Z",
          status: "Scheduled",
          isLive: true,
        },
      };
      vi.mocked(flightAwareService.validateFlight).mockResolvedValue(flightValidationResult);

      vi.mocked(mapsService.calculateAirportTripDuration).mockResolvedValue({
        durationMinutes: 60,
        distanceMeters: 30000,
        isEstimate: false,
      });

      vi.mocked(databaseService.car.findUnique).mockResolvedValue(createCar());

      vi.mocked(legService.generateLegs).mockReturnValue([
        {
          legDate: new Date("2025-02-01T00:00:00Z"),
          legStartTime: new Date("2025-02-01T15:10:00Z"),
          legEndTime: new Date("2025-02-01T16:22:00Z"),
        },
      ]);

      vi.mocked(calculationService.calculateBookingCost).mockResolvedValue(
        createBookingFinancials(),
      );
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([]);
      vi.mocked(flutterwaveService.getWebhookUrl).mockReturnValue(
        "https://api.example.com/api/payments/callback",
      );

      mockTransaction.mockImplementation(async (callback) => {
        const mockTx = {
          flight: { upsert: vi.fn().mockResolvedValue({ id: "BA74-20250201" }) },
          booking: {
            create: vi.fn().mockResolvedValue({
              id: "booking-123",
              bookingReference: "BK-123456-ABC",
              totalAmount: new Decimal(56437.5),
              status: BookingStatus.PENDING,
            }),
            update: vi.fn(),
          },
          referralProgramConfig: { findMany: vi.fn().mockResolvedValue([]) },
          referralReward: { create: vi.fn() },
          userReferralStats: { upsert: vi.fn() },
        };

        return callback(mockTx);
      });

      vi.mocked(flutterwaveService.createPaymentIntent).mockResolvedValue({
        paymentIntentId: "pi-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      });

      vi.mocked(flightAwareService.getOrCreateFlightAlert).mockResolvedValue("alert-123");

      const booking = createBookingInput({
        bookingType: "AIRPORT_PICKUP",
        flightNumber: "BA74",
        pickupTime: undefined,
      });
      const user = createUserContext();

      const result = await service.createBooking({ booking, user });

      expect(result.bookingId).toBe("booking-123");
      expect(flightAwareService.validateFlight).toHaveBeenCalledWith("BA74", "2025-02-01");
      expect(mapsService.calculateAirportTripDuration).toHaveBeenCalled();
    });

    it("should throw FlightValidationException when flight is not found", async () => {
      const validResult: ValidationResult = { valid: true, errors: [] };
      vi.mocked(validationService.validateDates).mockReturnValue(validResult);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(validResult);

      vi.mocked(flightAwareService.validateFlight).mockResolvedValue({
        type: "notFound",
      });

      const booking = createBookingInput({
        bookingType: "AIRPORT_PICKUP",
        flightNumber: "INVALID123",
        pickupTime: undefined,
      });
      const user = createUserContext();

      await expect(service.createBooking({ booking, user })).rejects.toThrow(
        FlightValidationException,
      );
    });

    it("should throw FlightValidationException when flight has already landed", async () => {
      const validResult: ValidationResult = { valid: true, errors: [] };
      vi.mocked(validationService.validateDates).mockReturnValue(validResult);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(validResult);

      vi.mocked(flightAwareService.validateFlight).mockResolvedValue({
        type: "alreadyLanded",
        flightNumber: "BA74",
        requestedDate: "2025-02-01",
        landedTime: "2:30 PM",
        nextFlightDate: "2025-02-02",
      });

      const booking = createBookingInput({
        bookingType: "AIRPORT_PICKUP",
        flightNumber: "BA74",
        pickupTime: undefined,
      });
      const user = createUserContext();

      await expect(service.createBooking({ booking, user })).rejects.toThrow(
        FlightValidationException,
      );
    });
  });

  describe("createBooking - Referral Handling", () => {
    it("should apply referral discount for eligible users", async () => {
      const validResult: ValidationResult = { valid: true, errors: [] };
      vi.mocked(validationService.validateDates).mockReturnValue(validResult);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(validResult);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue(validResult);

      vi.mocked(databaseService.car.findUnique).mockResolvedValue(createCar());

      vi.mocked(legService.generateLegs).mockReturnValue([
        {
          legDate: new Date("2025-02-01T00:00:00Z"),
          legStartTime: new Date("2025-02-01T09:00:00Z"),
          legEndTime: new Date("2025-02-01T21:00:00Z"),
        },
      ]);

      // Mock referral config - user is eligible for discount
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([
        { key: "REFERRAL_ENABLED", value: true, updatedAt: new Date(), updatedBy: null },
        { key: "REFERRAL_DISCOUNT_AMOUNT", value: "5000", updatedAt: new Date(), updatedBy: null },
      ]);

      vi.mocked(calculationService.calculateBookingCost).mockResolvedValue(
        createBookingFinancials({ referralDiscountAmount: new Decimal(5000) }),
      );

      vi.mocked(flutterwaveService.getWebhookUrl).mockReturnValue(
        "https://api.example.com/api/payments/callback",
      );

      mockTransaction.mockImplementation(async (callback) => {
        const mockTx = {
          flight: { upsert: vi.fn().mockResolvedValue({ id: "flight-123" }) },
          booking: {
            create: vi.fn().mockResolvedValue({
              id: "booking-123",
              bookingReference: "BK-123456-ABC",
              totalAmount: new Decimal(51437.5), // Reduced by discount
              status: BookingStatus.PENDING,
            }),
            update: vi.fn(),
          },
          referralProgramConfig: {
            findMany: vi.fn().mockResolvedValue([
              { key: "REFERRAL_REWARD_AMOUNT", value: "2500" },
              { key: "REFERRAL_RELEASE_CONDITION", value: "COMPLETED" },
            ]),
          },
          referralReward: { create: vi.fn() },
          userReferralStats: { upsert: vi.fn() },
        };

        return callback(mockTx);
      });

      vi.mocked(flutterwaveService.createPaymentIntent).mockResolvedValue({
        paymentIntentId: "pi-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      });

      const booking = createBookingInput();
      const user: BookingCreationInput["user"] = {
        id: "user-123",
        email: "user@example.com",
        name: "Test User",
        phoneNumber: "08012345678",
        referredByUserId: "referrer-123", // User was referred
        referralDiscountUsed: false, // Discount not yet used
      };

      const result = await service.createBooking({ booking, user });

      expect(result.bookingId).toBe("booking-123");

      // Verify referral discount was passed to calculation
      expect(calculationService.calculateBookingCost).toHaveBeenCalledWith(
        expect.objectContaining({
          referralDiscountAmount: new Decimal(5000),
        }),
      );
    });

    it("should not apply referral discount for guest users", async () => {
      const validResult: ValidationResult = { valid: true, errors: [] };
      vi.mocked(validationService.validateDates).mockReturnValue(validResult);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(validResult);
      vi.mocked(validationService.validateGuestEmail).mockResolvedValue(validResult);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue(validResult);

      vi.mocked(databaseService.car.findUnique).mockResolvedValue(createCar());

      vi.mocked(legService.generateLegs).mockReturnValue([
        {
          legDate: new Date("2025-02-01T00:00:00Z"),
          legStartTime: new Date("2025-02-01T09:00:00Z"),
          legEndTime: new Date("2025-02-01T21:00:00Z"),
        },
      ]);

      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([]);
      vi.mocked(calculationService.calculateBookingCost).mockResolvedValue(
        createBookingFinancials(),
      );

      vi.mocked(flutterwaveService.getWebhookUrl).mockReturnValue(
        "https://api.example.com/api/payments/callback",
      );

      mockTransaction.mockImplementation(async (callback) => {
        const mockTx = {
          flight: { upsert: vi.fn().mockResolvedValue({ id: "flight-123" }) },
          booking: {
            create: vi.fn().mockResolvedValue({
              id: "booking-123",
              bookingReference: "BK-123456-ABC",
              totalAmount: new Decimal(56437.5),
              status: BookingStatus.PENDING,
            }),
            update: vi.fn(),
          },
          referralProgramConfig: { findMany: vi.fn().mockResolvedValue([]) },
          referralReward: { create: vi.fn() },
          userReferralStats: { upsert: vi.fn() },
        };

        return callback(mockTx);
      });

      vi.mocked(flutterwaveService.createPaymentIntent).mockResolvedValue({
        paymentIntentId: "pi-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      });

      const booking = createGuestBookingInput();

      await service.createBooking({ booking, user: null });

      // Verify no referral discount was passed
      expect(calculationService.calculateBookingCost).toHaveBeenCalledWith(
        expect.objectContaining({
          referralDiscountAmount: new Decimal(0),
        }),
      );
    });
  });
});
