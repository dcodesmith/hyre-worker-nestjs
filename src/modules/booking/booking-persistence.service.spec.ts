import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { PaymentStatus, type Prisma } from "@prisma/client";
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
    const car = createCar();
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
    await expect(service.fetchCarWithPricing("car-1")).resolves.toEqual(car);
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
      },
    });
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
    };

    const financials = createBookingFinancials({
      numberOfLegs: 1,
      legPrices: [{ legDate: new Date("2026-03-03T00:00:00.000Z"), price: new Decimal(10000) }],
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
              { legDate: new Date("2026-03-03T00:00:00.000Z"), price: new Decimal(10000) },
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
