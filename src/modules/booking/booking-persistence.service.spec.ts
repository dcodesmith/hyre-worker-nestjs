import { Test, type TestingModule } from "@nestjs/testing";
import type { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";
import { createBookingFinancials, createCar } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { BookingCreationFailedException, CarNotFoundException } from "./booking.error";
import { BookingPersistenceService } from "./booking-persistence.service";
import type { CreateBookingDto } from "./dto/create-booking.dto";

describe("BookingPersistenceService", () => {
  it("throws CarNotFoundException when car is missing", async () => {
    const databaseService = {
      car: { findUnique: vi.fn().mockResolvedValue(null) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPersistenceService,
        { provide: DatabaseService, useValue: databaseService },
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
          netPerLeg: new Decimal(0),
          commissionPerLeg: new Decimal(0),
          earningsPerLeg: new Decimal(0),
          platformFleetOwnerCommissionRatePercent: new Decimal(10),
        },
      ),
    ).rejects.toThrow(BookingCreationFailedException);
  });
});
