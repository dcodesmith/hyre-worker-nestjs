import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, ChauffeurApprovalStatus } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
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
  let customerEmail: string;
  let customerPhone: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: async () => undefined })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
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
    await databaseService.user.update({
      where: { id: ownerId },
      data: {
        fleetOwnerStatus: "APPROVED",
        hasOnboarded: true,
        emailVerified: true,
      },
    });

    const nonOwnerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("fleet-booking-user"),
      "user",
    );
    nonOwnerCookie = nonOwnerAuth.cookie;

    const ownerCar = await factory.createCar(ownerId, { registrationNumber: "E2E-BOOK-001" });
    ownerCarId = ownerCar.id;
    customerEmail = uniqueEmail("fleet-booking-customer");
    customerPhone = `+23480${String(Date.now()).slice(-8)}`;
    customerId = (
      await factory.createUser({
        email: customerEmail,
        name: "Fleet Booking Customer",
        phoneNumber: customerPhone,
      })
    ).id;
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

  it("lists only the owner's paid bookings without customer contacts", async () => {
    const visibleBooking = await factory.createBooking(customerId, ownerCarId, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
    const unpaidBooking = await factory.createBooking(customerId, ownerCarId, {
      status: "PENDING",
      paymentStatus: "UNPAID",
    });
    const otherOwner = await factory.createFleetOwner({
      email: uniqueEmail("fleet-booking-list-other-owner"),
    });
    const otherOwnerCar = await factory.createCar(otherOwner.id);
    const otherOwnerBooking = await factory.createBooking(customerId, otherOwnerCar.id, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });

    const response = await request(app.getHttpServer())
      .get("/api/fleet-owner/bookings?page=1&limit=100")
      .set("Cookie", ownerCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.meta).toEqual(
      expect.objectContaining({ page: 1, limit: 100, total: expect.any(Number) }),
    );
    expect(response.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: visibleBooking.id })]),
    );
    expect(response.body.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: unpaidBooking.id }),
        expect.objectContaining({ id: otherOwnerBooking.id }),
      ]),
    );
    expect(JSON.stringify(response.body)).not.toContain(customerEmail);
    expect(JSON.stringify(response.body)).not.toContain(customerPhone);
  });

  it("returns an owner-scoped paid booking detail without customer contacts", async () => {
    const visibleBooking = await factory.createBooking(customerId, ownerCarId, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
    const unpaidBooking = await factory.createBooking(customerId, ownerCarId, {
      status: "PENDING",
      paymentStatus: "UNPAID",
    });
    const otherOwner = await factory.createFleetOwner({
      email: uniqueEmail("fleet-booking-detail-other-owner"),
    });
    const otherOwnerCar = await factory.createCar(otherOwner.id);
    const otherOwnerBooking = await factory.createBooking(customerId, otherOwnerCar.id, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });

    const response = await request(app.getHttpServer())
      .get(`/api/fleet-owner/bookings/${visibleBooking.id}`)
      .set("Cookie", ownerCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.booking).toEqual(
      expect.objectContaining({
        id: visibleBooking.id,
        customerName: "Fleet Booking Customer",
      }),
    );
    expect(JSON.stringify(response.body)).not.toContain(customerEmail);
    expect(JSON.stringify(response.body)).not.toContain(customerPhone);

    await request(app.getHttpServer())
      .get(`/api/fleet-owner/bookings/${unpaidBooking.id}`)
      .set("Cookie", ownerCookie)
      .expect(HttpStatus.NOT_FOUND);
    await request(app.getHttpServer())
      .get(`/api/fleet-owner/bookings/${otherOwnerBooking.id}`)
      .set("Cookie", ownerCookie)
      .expect(HttpStatus.NOT_FOUND);
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
