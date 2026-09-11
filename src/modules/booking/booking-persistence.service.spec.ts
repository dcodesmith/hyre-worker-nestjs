import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, ChauffeurApprovalStatus, PaymentStatus, type Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";
import { createBookingFinancials, createCar } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { BookingCreationFailedException, CarNotFoundException } from "./booking.error";
import { BookingPersistenceService } from "./booking-persistence.service";
import type { CreateBookingDto } from "./dto/create-booking.dto";

describe("BookingPersistenceService", () => {
  it("marks booking unpaid only when status is not PAID", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const databaseService = {
      car: { findUnique: vi.fn() },
      booking: { updateMany },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPersistenceService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue("DNMM") } },
      ],
    }).compile();

    const service = module.get<BookingPersistenceService>(BookingPersistenceService);
    await service.markBookingUnpaid("booking-1");

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "booking-1", paymentStatus: { not: PaymentStatus.PAID } },
      data: { paymentStatus: PaymentStatus.UNPAID },
    });
  });

  it("returns car with pricing fields when car exists", async () => {
    const car = {
      id: "car-1",
      ownerId: "owner-123",
      dayRate: 15000,
      nightRate: 20000,
      fullDayRate: 25000,
      airportPickupRate: 30000,
      fuelUpgradeRate: 5000,
      pricingIncludesFuel: false,
      owner: {
        id: "owner-123",
        isOwnerDriver: false,
        chauffeurApprovalStatus: null,
        chauffeurDisabledAt: null,
      },
    };
    const databaseService = {
      car: { findUnique: vi.fn().mockResolvedValue(car) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPersistenceService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue("DNMM") } },
      ],
    }).compile();

    const service = module.get<BookingPersistenceService>(BookingPersistenceService);
    await expect(service.fetchCarWithPricing("car-1")).resolves.toEqual({
      id: "car-1",
      ownerId: "owner-123",
      dayRate: 15000,
      nightRate: 20000,
      fullDayRate: 25000,
      airportPickupRate: 30000,
      fuelUpgradeRate: 5000,
      pricingIncludesFuel: false,
      ownerDriverId: null,
    });
    expect(databaseService.car.findUnique).toHaveBeenCalledWith({
      where: { id: "car-1" },
      select: {
        id: true,
        ownerId: true,
        dayRate: true,
        nightRate: true,
        fullDayRate: true,
        airportPickupRate: true,
        fuelUpgradeRate: true,
        pricingIncludesFuel: true,
        owner: {
          select: {
            id: true,
            isOwnerDriver: true,
            chauffeurApprovalStatus: true,
            chauffeurDisabledAt: true,
          },
        },
      },
    });
  });

  it.each([
    [
      "an approved active owner-driver",
      {
        isOwnerDriver: true,
        chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
        chauffeurDisabledAt: null,
      },
      "owner-123",
    ],
    [
      "a disabled owner-driver",
      {
        isOwnerDriver: true,
        chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
        chauffeurDisabledAt: new Date("2026-09-01T00:00:00Z"),
      },
      null,
    ],
    [
      "an unapproved owner-driver",
      {
        isOwnerDriver: true,
        chauffeurApprovalStatus: ChauffeurApprovalStatus.PENDING,
        chauffeurDisabledAt: null,
      },
      null,
    ],
  ] as const)("derives ownerDriverId for %s", async (_label, owner, ownerDriverId) => {
    const databaseService = {
      car: {
        findUnique: vi.fn().mockResolvedValue({
          id: "car-1",
          ownerId: "owner-123",
          dayRate: 15000,
          nightRate: 20000,
          fullDayRate: 25000,
          airportPickupRate: 30000,
          fuelUpgradeRate: 5000,
          pricingIncludesFuel: false,
          owner: { id: "owner-123", ...owner },
        }),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPersistenceService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue("DNMM") } },
      ],
    }).compile();

    const service = module.get<BookingPersistenceService>(BookingPersistenceService);
    await expect(service.fetchCarWithPricing("car-1")).resolves.toMatchObject({ ownerDriverId });
  });

  it("throws CarNotFoundException when car is missing", async () => {
    const databaseService = {
      car: { findUnique: vi.fn().mockResolvedValue(null) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPersistenceService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue("DNMM") } },
      ],
    }).compile();

    const service = module.get<BookingPersistenceService>(BookingPersistenceService);
    await expect(service.fetchCarWithPricing("car-404")).rejects.toThrow(CarNotFoundException);
  });

  it("persists the departure date and origin timezone used by FlightAware alerts", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "flight-1" });
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPersistenceService,
        { provide: DatabaseService, useValue: {} },
        { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue("DNMM") } },
      ],
    }).compile();
    const service = module.get<BookingPersistenceService>(BookingPersistenceService);
    const departureTime = new Date("2030-01-01T22:00:00.000Z");
    const arrivalTime = new Date("2030-01-02T05:30:00.000Z");

    await expect(
      service.createFlightRecordIfNeeded(
        { flight: { upsert, updateMany } },
        {
          carId: "car-1",
          bookingType: "AIRPORT_PICKUP",
          startDate: new Date("2030-01-02T06:10:00.000Z"),
          endDate: new Date("2030-01-02T18:10:00.000Z"),
          pickupAddress: "Murtala Muhammed International Airport",
          pickupTime: "6:10 AM",
          dropOffAddress: "Victoria Island, Lagos",
          flightNumber: "BA74",
          sameLocation: false,
          includeSecurityDetail: false,
          requiresFullTank: false,
          useCredits: 0,
          expectedTotalAmount: "10000",
        },
        {
          flightId: "flight-1",
          flightNumber: "BA74",
          departureTime,
          arrivalTime,
          originCode: "EGLL",
          originCodeIATA: "LHR",
          originTimezone: "Europe/London",
          originName: "London Heathrow",
          destinationCode: "DNMM",
          destinationIATA: "LOS",
          destinationName: "Murtala Muhammed International Airport",
          destinationCity: "Lagos",
        },
      ),
    ).resolves.toBe("flight-1");
    expect(upsert).toHaveBeenCalledWith({
      where: { id: "flight-1" },
      create: expect.objectContaining({
        flightDate: departureTime,
        scheduledDeparture: departureTime,
        scheduledArrival: arrivalTime,
        originTimezone: "Europe/London",
      }),
      update: {},
      select: { id: true },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "flight-1",
        scheduledDeparture: null,
      },
      data: {
        flightDate: departureTime,
        scheduledDeparture: departureTime,
        originTimezone: "Europe/London",
      },
    });
  });

  it("throws BookingCreationFailedException when number of legs is zero", async () => {
    const databaseService = {
      car: { findUnique: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPersistenceService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue("DNMM") } },
      ],
    }).compile();

    const service = module.get<BookingPersistenceService>(BookingPersistenceService);
    const bookingInput: CreateBookingDto = {
      carId: "car-1",
      bookingType: "DAY",
      startDate: new Date("2026-03-03T10:00:00.000Z"),
      endDate: new Date("2026-03-03T22:00:00.000Z"),
      pickupAddress: "Airport",
      pickupTime: "10 AM",
      sameLocation: true,
      includeSecurityDetail: false,
      requiresFullTank: false,
      useCredits: 0,
      expectedTotalAmount: "10000",
    };

    await expect(
      service.createBookingRecord(
        {
          booking: { create: vi.fn() },
        } as unknown as Prisma.TransactionClient,
        {
          bookingReference: "BK-123",
          car: createCar(),
          userId: "user-1",
          guestUser: null,
          booking: bookingInput,
          financials: createBookingFinancials({ numberOfLegs: 0, legPrices: [] }),
          referralEligibility: {
            eligible: false,
            referrerUserId: null,
            discountAmount: new Decimal(0),
          },
          flightRecordId: null,
          legs: [],
        },
      ),
    ).rejects.toThrow(BookingCreationFailedException);
  });

  it("creates booking record for valid payload", async () => {
    const databaseService = {
      car: { findUnique: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPersistenceService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue("DNMM") } },
      ],
    }).compile();

    const service = module.get<BookingPersistenceService>(BookingPersistenceService);
    const createBooking = vi.fn().mockResolvedValue({ id: "booking-1" });
    const tx = {
      booking: { create: createBooking },
    } as unknown as Prisma.TransactionClient;

    const bookingInput: CreateBookingDto = {
      carId: "car-1",
      bookingType: "DAY",
      startDate: new Date("2026-03-03T10:00:00.000Z"),
      endDate: new Date("2026-03-03T22:00:00.000Z"),
      pickupAddress: "Airport",
      pickupTime: "10 AM",
      sameLocation: true,
      includeSecurityDetail: false,
      requiresFullTank: false,
      useCredits: 0,
      expectedTotalAmount: "10000",
    };

    const financials = createBookingFinancials({
      numberOfLegs: 1,
      legPrices: [
        {
          legDate: new Date("2026-03-03T00:00:00.000Z"),
          price: new Decimal(10000),
          basePrice: new Decimal(10000),
          promotion: null,
        },
      ],
    });
    const legs = [
      {
        legDate: new Date("2026-03-03T00:00:00.000Z"),
        legStartTime: new Date("2026-03-03T10:00:00.000Z"),
        legEndTime: new Date("2026-03-03T22:00:00.000Z"),
      },
    ];

    await expect(
      service.createBookingRecord(tx, {
        bookingReference: "BK-123",
        car: createCar(),
        userId: "user-1",
        guestUser: null,
        booking: bookingInput,
        financials,
        referralEligibility: {
          eligible: false,
          referrerUserId: null,
          discountAmount: new Decimal(0),
        },
        flightRecordId: null,
        legs,
      }),
    ).resolves.toEqual({ id: "booking-1" });

    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(createBooking).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        paymentSessionExpiresAt: expect.any(Date),
        chauffeurId: null,
      }),
    });
  });

  it("assigns an eligible owner-driver on the pending booking record", async () => {
    const databaseService = {
      car: { findUnique: vi.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPersistenceService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue("DNMM") } },
      ],
    }).compile();
    const service = module.get<BookingPersistenceService>(BookingPersistenceService);
    const createBooking = vi.fn().mockResolvedValue({ id: "booking-1" });
    const tx = { booking: { create: createBooking } } as unknown as Prisma.TransactionClient;
    const bookingInput: CreateBookingDto = {
      carId: "car-1",
      bookingType: "DAY",
      startDate: new Date("2026-03-03T10:00:00.000Z"),
      endDate: new Date("2026-03-03T22:00:00.000Z"),
      pickupAddress: "Airport",
      pickupTime: "10 AM",
      sameLocation: true,
      includeSecurityDetail: false,
      requiresFullTank: false,
      useCredits: 0,
      expectedTotalAmount: "10000",
    };
    const financials = createBookingFinancials({
      numberOfLegs: 1,
      legPrices: [
        {
          legDate: new Date("2026-03-03T00:00:00.000Z"),
          price: new Decimal(10000),
          basePrice: new Decimal(10000),
          promotion: null,
        },
      ],
    });

    await service.createBookingRecord(tx, {
      bookingReference: "BK-123",
      car: { ...createCar(), ownerDriverId: "owner-123" },
      userId: "user-1",
      guestUser: null,
      booking: bookingInput,
      financials,
      referralEligibility: {
        eligible: false,
        referrerUserId: null,
        discountAmount: new Decimal(0),
      },
      flightRecordId: null,
      legs: [
        {
          legDate: new Date("2026-03-03T00:00:00.000Z"),
          legStartTime: new Date("2026-03-03T10:00:00.000Z"),
          legEndTime: new Date("2026-03-03T22:00:00.000Z"),
        },
      ],
    });

    expect(createBooking).toHaveBeenCalledWith({
      data: expect.objectContaining({ chauffeurId: "owner-123" }),
    });
  });

  it("throws when financials.numberOfLegs does not match legs length", async () => {
    const databaseService = {
      car: { findUnique: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPersistenceService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue("DNMM") } },
      ],
    }).compile();

    const service = module.get<BookingPersistenceService>(BookingPersistenceService);
    const bookingInput: CreateBookingDto = {
      carId: "car-1",
      bookingType: "DAY",
      startDate: new Date("2026-03-03T10:00:00.000Z"),
      endDate: new Date("2026-03-03T22:00:00.000Z"),
      pickupAddress: "Airport",
      pickupTime: "10 AM",
      sameLocation: true,
      includeSecurityDetail: false,
      requiresFullTank: false,
      useCredits: 0,
      expectedTotalAmount: "10000",
    };

    await expect(
      service.createBookingRecord(
        { booking: { create: vi.fn() } } as unknown as Prisma.TransactionClient,
        {
          bookingReference: "BK-123",
          car: createCar(),
          userId: "user-1",
          guestUser: null,
          booking: bookingInput,
          financials: createBookingFinancials({
            numberOfLegs: 2,
            legPrices: [
              {
                legDate: new Date("2026-03-03T00:00:00.000Z"),
                price: new Decimal(10000),
                basePrice: new Decimal(10000),
                promotion: null,
              },
            ],
          }),
          referralEligibility: {
            eligible: false,
            referrerUserId: null,
            discountAmount: new Decimal(0),
          },
          flightRecordId: null,
          legs: [
            {
              legDate: new Date("2026-03-03T00:00:00.000Z"),
              legStartTime: new Date("2026-03-03T10:00:00.000Z"),
              legEndTime: new Date("2026-03-03T22:00:00.000Z"),
            },
          ],
        },
      ),
    ).rejects.toThrow(BookingCreationFailedException);
  });
});
