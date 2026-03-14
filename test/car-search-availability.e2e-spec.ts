import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory } from "./helpers";

describe("Car Search Availability E2E Flow", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let ownerId: string;
  let bookingUserId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);
    await app.init();

    const owner = await factory.createFleetOwner({
      isOwnerDriver: true,
    });
    ownerId = owner.id;
    await databaseService.user.update({
      where: { id: ownerId },
      data: { fleetOwnerStatus: "APPROVED", hasOnboarded: true, isOwnerDriver: true },
    });

    const bookingUser = await factory.createUser();
    bookingUserId = bookingUser.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("filters DAY but allows NIGHT/FULL_DAY when car has exact 2-hour post-booking gap", async () => {
    const [carA, carB, carC] = await Promise.all([
      factory.createCar(ownerId, {
        registrationNumber: "BUF-201AA",
        approvalStatus: "APPROVED",
        status: "AVAILABLE",
      }),
      factory.createCar(ownerId, {
        registrationNumber: "BUF-202AA",
        approvalStatus: "APPROVED",
        status: "AVAILABLE",
      }),
      factory.createCar(ownerId, {
        registrationNumber: "BUF-203AA",
        approvalStatus: "APPROVED",
        status: "AVAILABLE",
      }),
    ]);

    const bookingDate = new Date("2030-03-10T00:00:00.000Z");
    // 09:00-21:00 Lagos (WAT) represented in UTC.
    const bookingStart = new Date("2030-03-10T08:00:00.000Z");
    const bookingEnd = new Date("2030-03-10T20:00:00.000Z");

    await factory.createBooking(bookingUserId, carA.id, {
      bookingReference: "BOOK-BUFFER-A-E2E",
      startDate: bookingStart,
      endDate: bookingEnd,
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      totalAmount: 50000,
    });

    const dayResponse = await request(app.getHttpServer()).get(
      `/api/cars/search?page=1&limit=50&from=${bookingDate.toISOString()}&to=${bookingDate.toISOString()}&bookingType=DAY&pickupTime=9:00%20AM`,
    );
    expect(dayResponse.status).toBe(HttpStatus.OK);
    const dayIds = dayResponse.body.cars.map((car: { id: string }) => car.id);
    expect(dayIds).not.toContain(carA.id);
    expect(dayIds).toContain(carB.id);
    expect(dayIds).toContain(carC.id);

    const nextDate = new Date("2030-03-11T00:00:00.000Z");
    const nightResponse = await request(app.getHttpServer()).get(
      `/api/cars/search?page=1&limit=50&from=${bookingDate.toISOString()}&to=${nextDate.toISOString()}&bookingType=NIGHT`,
    );
    expect(nightResponse.status).toBe(HttpStatus.OK);
    const nightIds = nightResponse.body.cars.map((car: { id: string }) => car.id);
    expect(nightIds).toContain(carA.id);
    expect(nightIds).toContain(carB.id);
    expect(nightIds).toContain(carC.id);

    const fullDayResponse = await request(app.getHttpServer()).get(
      `/api/cars/search?page=1&limit=50&from=${bookingDate.toISOString()}&to=${nextDate.toISOString()}&bookingType=FULL_DAY&pickupTime=11:00%20PM`,
    );
    expect(fullDayResponse.status).toBe(HttpStatus.OK);
    const fullDayIds = fullDayResponse.body.cars.map((car: { id: string }) => car.id);
    expect(fullDayIds).toContain(carA.id);
    expect(fullDayIds).toContain(carB.id);
    expect(fullDayIds).toContain(carC.id);
  });
});
