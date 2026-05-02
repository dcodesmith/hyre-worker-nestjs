import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, ChauffeurApprovalStatus } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Fleet Owner Booking E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;

  let ownerId: string;
  let ownerCookie: string;
  let nonOwnerCookie: string;
  let ownerCarId: string;
  let customerId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: async () => undefined })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));
    await app.init();

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);

    const ownerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("fleet-booking-owner"),
      "fleetOwner",
      "web",
    );
    ownerId = ownerAuth.user.id;
    ownerCookie = ownerAuth.cookie;

    const nonOwnerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("fleet-booking-user"),
      "user",
    );
    nonOwnerCookie = nonOwnerAuth.cookie;

    const ownerCar = await factory.createCar(ownerId, { registrationNumber: "E2E-BOOK-001" });
    ownerCarId = ownerCar.id;
    customerId = (await factory.createUser({ email: uniqueEmail("fleet-booking-customer") })).id;
  });

  beforeEach(async () => {
    await factory.clearRateLimits();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await request(app.getHttpServer())
      .patch("/api/fleet-owner/bookings/some-booking/chauffeur")
      .send({ chauffeurId: "some-chauffeur" });

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("returns 403 for non-fleet-owner user", async () => {
    const booking = await factory.createBooking(customerId, ownerCarId, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });

    const response = await request(app.getHttpServer())
      .patch(`/api/fleet-owner/bookings/${booking.id}/chauffeur`)
      .set("Cookie", nonOwnerCookie)
      .send({ chauffeurId: "any-chauffeur-id" });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("assigns an approved owner chauffeur to a confirmed booking", async () => {
    const booking = await factory.createBooking(customerId, ownerCarId, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
    const chauffeur = await factory.createChauffeur({
      email: uniqueEmail("fleet-booking-approved"),
    });
    await databaseService.user.update({
      where: { id: chauffeur.id },
      data: {
        fleetOwnerId: ownerId,
        chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
      },
    });

    const response = await request(app.getHttpServer())
      .patch(`/api/fleet-owner/bookings/${booking.id}/chauffeur`)
      .set("Cookie", ownerCookie)
      .send({ chauffeurId: chauffeur.id });

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.id).toBe(booking.id);
    expect(response.body.chauffeur?.id ?? response.body.chauffeurId).toBe(chauffeur.id);

    const updated = await factory.getBookingById(booking.id);
    expect(updated?.chauffeurId).toBe(chauffeur.id);
  });

  it("returns 409 when booking is not confirmed", async () => {
    const booking = await factory.createBooking(customerId, ownerCarId, {
      status: BookingStatus.ACTIVE,
      paymentStatus: "PAID",
    });
    const chauffeur = await factory.createChauffeur({ email: uniqueEmail("fleet-booking-active") });
    await databaseService.user.update({
      where: { id: chauffeur.id },
      data: {
        fleetOwnerId: ownerId,
        chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
      },
    });

    const response = await request(app.getHttpServer())
      .patch(`/api/fleet-owner/bookings/${booking.id}/chauffeur`)
      .set("Cookie", ownerCookie)
      .send({ chauffeurId: chauffeur.id });

    expect(response.status).toBe(HttpStatus.CONFLICT);
  });

  it("returns 409 when chauffeur is not approved", async () => {
    const booking = await factory.createBooking(customerId, ownerCarId, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
    const chauffeur = await factory.createChauffeur({
      email: uniqueEmail("fleet-booking-pending"),
    });
    await databaseService.user.update({
      where: { id: chauffeur.id },
      data: {
        fleetOwnerId: ownerId,
        chauffeurApprovalStatus: ChauffeurApprovalStatus.PENDING,
      },
    });

    const response = await request(app.getHttpServer())
      .patch(`/api/fleet-owner/bookings/${booking.id}/chauffeur`)
      .set("Cookie", ownerCookie)
      .send({ chauffeurId: chauffeur.id });

    expect(response.status).toBe(HttpStatus.CONFLICT);
  });

  it("returns 404 when chauffeur belongs to another fleet owner", async () => {
    const booking = await factory.createBooking(customerId, ownerCarId, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
    const otherOwner = await factory.createFleetOwner({
      email: uniqueEmail("fleet-booking-other-owner"),
    });
    const otherOwnerChauffeur = await factory.createChauffeur({
      email: uniqueEmail("fleet-booking-other-owner-chauffeur"),
    });
    await databaseService.user.update({
      where: { id: otherOwnerChauffeur.id },
      data: {
        fleetOwnerId: otherOwner.id,
        chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
      },
    });

    const response = await request(app.getHttpServer())
      .patch(`/api/fleet-owner/bookings/${booking.id}/chauffeur`)
      .set("Cookie", ownerCookie)
      .send({ chauffeurId: otherOwnerChauffeur.id });

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
    expect(response.body.errorCode).toBe("BOOKING_CHAUFFEUR_NOT_FOUND");
    expect(response.body.detail).toBe("Chauffeur not found for this fleet owner");
  });
});
