import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBookingFinancials, createCar, createUser } from "../../shared/helper.fixtures";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import {
  FlightAlreadyLandedException,
  FlightNotFoundException,
} from "../flightaware/flightaware.error";
import type { ValidatedFlight } from "../flightaware/flightaware.interface";
import { FlightAwareService } from "../flightaware/flightaware.service";
import { FlutterwaveError } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { MapsService } from "../maps/maps.service";
import {
  BookingCreationFailedException,
  BookingValidationException,
  CarNotAvailableException,
  CarNotFoundException,
  PaymentIntentFailedException,
  ReferralDiscountNoLongerAvailableException,
} from "./booking.error";
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

// Helper to create session user context (AuthSession["user"] type from Better Auth)
const createSessionUser = (overrides: Partial<AuthSession["user"]> = {}): AuthSession["user"] => ({
  id: "user-123",
  email: "user@example.com",
  name: "Test User",
  emailVerified: true,
  image: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
  roles: ["user"],
  ...overrides,
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
            user: { findUnique: vi.fn(), update: vi.fn() },
            booking: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
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
    // Validation methods now return void and throw on failure, so we just mock them to do nothing
    const setupSuccessfulMocks = () => {
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);
      vi.mocked(validationService.validateGuestEmail).mockResolvedValue(undefined);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue(undefined);

      vi.mocked(databaseService.car.findUnique).mockResolvedValue(createCar());
      vi.mocked(databaseService.user.findUnique).mockResolvedValue(createUser());
      vi.mocked(databaseService.booking.findUnique).mockResolvedValue(null);

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
          user: { update: vi.fn() },
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
      const user = createSessionUser();

      const result = await service.createBooking(booking, user);

      expect(result).toEqual({
        bookingId: "booking-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
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

      const result = await service.createBooking(booking, null);

      expect(result).toEqual({
        bookingId: "booking-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      });

      expect(validationService.validateGuestEmail).toHaveBeenCalledWith(booking);
    });

    it("should throw BookingValidationException when date validation fails", async () => {
      vi.mocked(validationService.validateDates).mockImplementation(() => {
        throw new BookingValidationException([
          { field: "startDate", message: "Start date cannot be in the past" },
        ]);
      });

      const booking = createBookingInput();
      const user = createSessionUser();

      await expect(service.createBooking(booking, user)).rejects.toThrow(
        BookingValidationException,
      );

      expect(validationService.checkCarAvailability).not.toHaveBeenCalled();
    });

    it("should throw CarNotAvailableException when car is not available", async () => {
      vi.mocked(databaseService.user.findUnique).mockResolvedValue(createUser());
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockRejectedValue(
        new CarNotAvailableException("car-123", "Car is not available for the selected dates"),
      );

      const booking = createBookingInput();
      const user = createSessionUser();

      await expect(service.createBooking(booking, user)).rejects.toThrow(CarNotAvailableException);

      expect(databaseService.car.findUnique).not.toHaveBeenCalled();
    });

    it("should throw BookingValidationException when guest email is registered", async () => {
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);
      vi.mocked(validationService.validateGuestEmail).mockRejectedValue(
        new BookingValidationException([
          { field: "guestEmail", message: "This email is already registered" },
        ]),
      );

      const booking = createGuestBookingInput();

      await expect(service.createBooking(booking, null)).rejects.toThrow(
        BookingValidationException,
      );
    });

    it("should throw BookingValidationException when user is null but booking lacks guest fields", async () => {
      // Setup all mocks to get to the getCustomerDetails call
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);
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

      // Use a non-guest booking (no guestEmail, guestName, guestPhone)
      const booking = createBookingInput();

      // Pass user: null with a non-guest booking
      await expect(service.createBooking(booking, null)).rejects.toThrow(
        BookingValidationException,
      );
    });

    it("should throw CarNotFoundException when car does not exist", async () => {
      vi.mocked(databaseService.user.findUnique).mockResolvedValue(createUser());
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);
      vi.mocked(databaseService.car.findUnique).mockResolvedValue(null);

      const booking = createBookingInput();
      const user = createSessionUser();

      await expect(service.createBooking(booking, user)).rejects.toThrow(CarNotFoundException);
    });

    it("should throw BookingValidationException when price does not match", async () => {
      vi.mocked(databaseService.user.findUnique).mockResolvedValue(createUser());
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);
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
      vi.mocked(validationService.validatePriceMatch).mockImplementation(() => {
        throw new BookingValidationException([
          { field: "clientTotalAmount", message: "Price mismatch" },
        ]);
      });

      const booking = createBookingInput({ clientTotalAmount: "10000" });
      const user = createSessionUser();

      await expect(service.createBooking(booking, user)).rejects.toThrow(
        BookingValidationException,
      );
    });

    it("should throw PaymentIntentFailedException and mark booking as FAILED when payment creation fails", async () => {
      setupSuccessfulMocks();

      // Override createPaymentIntent to throw after transaction commits
      vi.mocked(flutterwaveService.createPaymentIntent).mockRejectedValue(
        new FlutterwaveError("Payment failed", "PAYMENT_FAILED"),
      );

      const booking = createBookingInput();
      const user = createSessionUser();

      await expect(service.createBooking(booking, user)).rejects.toThrow(
        PaymentIntentFailedException,
      );

      // Verify booking was marked as FAILED (compensation logic)
      expect(databaseService.booking.update).toHaveBeenCalledWith({
        where: { id: "booking-123" },
        data: { paymentStatus: PaymentStatus.UNPAID },
      });
    });

    it("should throw BookingCreationFailedException when numberOfLegs is zero", async () => {
      vi.mocked(databaseService.user.findUnique).mockResolvedValue(createUser());
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue(undefined);
      vi.mocked(databaseService.car.findUnique).mockResolvedValue(createCar());
      vi.mocked(databaseService.referralProgramConfig.findMany).mockResolvedValue([]);

      // Return empty legs array (edge case regression scenario)
      vi.mocked(legService.generateLegs).mockReturnValue([]);

      // BookingCalculationService returns numberOfLegs: 0 for empty legs array
      vi.mocked(calculationService.calculateBookingCost).mockResolvedValue(
        createBookingFinancials({ numberOfLegs: 0, legPrices: [] }),
      );

      const booking = createBookingInput();
      const user = createSessionUser();

      await expect(service.createBooking(booking, user)).rejects.toThrow(
        BookingCreationFailedException,
      );

      // Ensure transaction was never started (validation happens before)
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  });

  describe("createBooking - Airport Pickup", () => {
    it("should validate flight for airport pickup bookings", async () => {
      vi.mocked(databaseService.user.findUnique).mockResolvedValue(createUser());
      // Validation methods now return void
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue(undefined);

      const validatedFlight: ValidatedFlight = {
        flightNumber: "BA74",
        flightId: "BA74-20250201",
        origin: "EGLL",
        originIATA: "LHR",
        destination: "DNMM",
        destinationIATA: "LOS",
        scheduledArrival: "2025-02-01T14:30:00Z",
        status: "Scheduled",
        isLive: true,
      };
      vi.mocked(flightAwareService.validateFlight).mockResolvedValue(validatedFlight);

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
          user: { update: vi.fn() },
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
        sameLocation: false as const,
        dropOffAddress: "Victoria Island, Lagos",
      });
      const user = createSessionUser();

      const result = await service.createBooking(booking, user);

      expect(result.bookingId).toBe("booking-123");
      expect(flightAwareService.validateFlight).toHaveBeenCalledWith("BA74", "2025-02-01");
      expect(mapsService.calculateAirportTripDuration).toHaveBeenCalledWith(
        "Victoria Island, Lagos",
      );
    });

    it("should throw FlightNotFoundException when flight is not found", async () => {
      vi.mocked(databaseService.user.findUnique).mockResolvedValue(createUser());
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);

      vi.mocked(flightAwareService.validateFlight).mockRejectedValue(
        new FlightNotFoundException("INVALID123", "2025-02-01"),
      );

      const booking = createBookingInput({
        bookingType: "AIRPORT_PICKUP",
        flightNumber: "INVALID123",
        pickupTime: undefined,
        sameLocation: false as const,
        dropOffAddress: "Victoria Island, Lagos",
      });
      const user = createSessionUser();

      await expect(service.createBooking(booking, user)).rejects.toThrow(FlightNotFoundException);
    });

    it("should throw FlightAlreadyLandedException when flight has already landed", async () => {
      vi.mocked(databaseService.user.findUnique).mockResolvedValue(createUser());
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);

      vi.mocked(flightAwareService.validateFlight).mockRejectedValue(
        new FlightAlreadyLandedException("BA74", "2:30 PM", "2025-02-02"),
      );

      const booking = createBookingInput({
        bookingType: "AIRPORT_PICKUP",
        flightNumber: "BA74",
        pickupTime: undefined,
        sameLocation: false as const,
        dropOffAddress: "Victoria Island, Lagos",
      });
      const user = createSessionUser();

      await expect(service.createBooking(booking, user)).rejects.toThrow(
        FlightAlreadyLandedException,
      );
    });
  });

  describe("createBooking - Referral Handling", () => {
    it("should apply referral discount for eligible users", async () => {
      // Mock user in database with referral info (fetched for preliminary check)
      vi.mocked(databaseService.user.findUnique).mockResolvedValue(
        createUser({
          referredByUserId: "referrer-123", // User was referred
          referralDiscountUsed: false, // Discount not yet used
        }),
      );
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue(undefined);

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
          // Mock for pessimistic locking query - returns fresh user data showing discount not used
          $queryRaw: vi
            .fn()
            .mockResolvedValue([
              { id: "user-123", referredByUserId: "referrer-123", referralDiscountUsed: false },
            ]),
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
          user: { update: vi.fn() },
        };

        return callback(mockTx);
      });

      vi.mocked(flutterwaveService.createPaymentIntent).mockResolvedValue({
        paymentIntentId: "pi-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      });

      const booking = createBookingInput();
      // Session user only has Better Auth fields, not referral info
      const sessionUser = createSessionUser();

      const result = await service.createBooking(booking, sessionUser);

      expect(result.bookingId).toBe("booking-123");

      // Verify referral discount was passed to calculation
      expect(calculationService.calculateBookingCost).toHaveBeenCalledWith(
        expect.objectContaining({
          referralDiscountAmount: new Decimal(5000),
        }),
      );
    });

    it("should mark referralDiscountUsed=true within the transaction to prevent race conditions", async () => {
      // Mock user in database with referral info
      vi.mocked(databaseService.user.findUnique).mockResolvedValue(
        createUser({
          referredByUserId: "referrer-123",
          referralDiscountUsed: false,
        }),
      );
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue(undefined);

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

      const mockUserUpdate = vi.fn();

      mockTransaction.mockImplementation(async (callback) => {
        const mockTx = {
          // Mock for pessimistic locking query - returns fresh user data showing discount not used
          $queryRaw: vi
            .fn()
            .mockResolvedValue([
              { id: "user-123", referredByUserId: "referrer-123", referralDiscountUsed: false },
            ]),
          flight: { upsert: vi.fn().mockResolvedValue({ id: "flight-123" }) },
          booking: {
            create: vi.fn().mockResolvedValue({
              id: "booking-123",
              bookingReference: "BK-123456-ABC",
              totalAmount: new Decimal(51437.5),
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
          user: { update: mockUserUpdate },
        };

        return callback(mockTx);
      });

      vi.mocked(flutterwaveService.createPaymentIntent).mockResolvedValue({
        paymentIntentId: "pi-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      });

      const booking = createBookingInput();
      // Session user only has Better Auth fields
      const sessionUser = createSessionUser();

      await service.createBooking(booking, sessionUser);

      // Verify that user.referralDiscountUsed was set to true WITHIN the transaction
      // This prevents the race condition where concurrent bookings could all receive the discount
      expect(mockUserUpdate).toHaveBeenCalledWith({
        where: { id: "user-123" },
        data: { referralDiscountUsed: true },
      });
    });

    it("should throw ReferralDiscountNoLongerAvailableException when discount was already used (race condition)", async () => {
      // Mock user in database - preliminary check shows eligible
      vi.mocked(databaseService.user.findUnique).mockResolvedValue(
        createUser({
          referredByUserId: "referrer-123",
          referralDiscountUsed: false,
        }),
      );
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue(undefined);

      vi.mocked(databaseService.car.findUnique).mockResolvedValue(createCar());

      vi.mocked(legService.generateLegs).mockReturnValue([
        {
          legDate: new Date("2025-02-01T00:00:00Z"),
          legStartTime: new Date("2025-02-01T09:00:00Z"),
          legEndTime: new Date("2025-02-01T21:00:00Z"),
        },
      ]);

      // Preliminary check: user appears eligible (from initial DB query)
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

      // Simulate race condition: fresh DB query shows discount was already used
      mockTransaction.mockImplementation(async (callback) => {
        const mockTx = {
          // Fresh DB query with FOR UPDATE shows discount was already used by concurrent request
          $queryRaw: vi
            .fn()
            .mockResolvedValue([
              { id: "user-123", referredByUserId: "referrer-123", referralDiscountUsed: true },
            ]),
          flight: { upsert: vi.fn() },
          booking: { create: vi.fn(), update: vi.fn() },
          referralProgramConfig: { findMany: vi.fn() },
          referralReward: { create: vi.fn() },
          userReferralStats: { upsert: vi.fn() },
          user: { update: vi.fn() },
        };

        return callback(mockTx);
      });

      const booking = createBookingInput();
      // Session user only has Better Auth fields
      const sessionUser = createSessionUser();

      // Should throw because fresh DB query shows discount was already used
      await expect(service.createBooking(booking, sessionUser)).rejects.toThrow(
        ReferralDiscountNoLongerAvailableException,
      );
    });

    it("should not apply referral discount for guest users", async () => {
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);
      vi.mocked(validationService.validateGuestEmail).mockResolvedValue(undefined);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue(undefined);

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
          user: { update: vi.fn() },
        };

        return callback(mockTx);
      });

      vi.mocked(flutterwaveService.createPaymentIntent).mockResolvedValue({
        paymentIntentId: "pi-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      });

      const booking = createGuestBookingInput();

      await service.createBooking(booking, null);

      // Verify no referral discount was passed
      expect(calculationService.calculateBookingCost).toHaveBeenCalledWith(
        expect.objectContaining({
          referralDiscountAmount: new Decimal(0),
        }),
      );
    });

    it("should not apply referral discount when user has already used it (preliminary check)", async () => {
      // User was referred but already used their one-time discount
      vi.mocked(databaseService.user.findUnique).mockResolvedValue(
        createUser({
          referredByUserId: "referrer-123",
          referralDiscountUsed: true, // ✅ Already used!
        }),
      );
      vi.mocked(validationService.validateDates).mockReturnValue(undefined);
      vi.mocked(validationService.checkCarAvailability).mockResolvedValue(undefined);
      vi.mocked(validationService.validatePriceMatch).mockReturnValue(undefined);

      vi.mocked(databaseService.car.findUnique).mockResolvedValue(createCar());

      vi.mocked(legService.generateLegs).mockReturnValue([
        {
          legDate: new Date("2025-02-01T00:00:00Z"),
          legStartTime: new Date("2025-02-01T09:00:00Z"),
          legEndTime: new Date("2025-02-01T21:00:00Z"),
        },
      ]);

      // No referral config should be queried since preliminary check fails
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
          user: { update: vi.fn() },
        };

        return callback(mockTx);
      });

      vi.mocked(flutterwaveService.createPaymentIntent).mockResolvedValue({
        paymentIntentId: "pi-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      });

      const booking = createBookingInput();
      const user = createSessionUser();

      await service.createBooking(booking, user);

      // CRITICAL: Verify NO discount was applied (user already used it)
      expect(calculationService.calculateBookingCost).toHaveBeenCalledWith(
        expect.objectContaining({
          referralDiscountAmount: new Decimal(0),
        }),
      );

      // Verify referral config was NOT fetched (preliminary check caught it)
      expect(databaseService.referralProgramConfig.findMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: { in: ["REFERRAL_ENABLED", "REFERRAL_DISCOUNT_AMOUNT"] } },
        }),
      );
    });
  });
});
