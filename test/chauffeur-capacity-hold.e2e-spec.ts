import { randomUUID } from "node:crypto";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { BookingConfirmationService } from "../src/modules/booking/booking-confirmation.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { EmailService } from "../src/modules/email/email.service";
import { FlutterwaveService } from "../src/modules/flutterwave/flutterwave.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

function createBookingWindow(startDate: string, endDate: string) {
  return {
    startDate,
    endDate,
    pickupAddress: "123 Main St, Lagos",
    bookingType: "DAY" as const,
    pickupTime: "9:00 AM",
    sameLocation: true,
    requiresFullTank: false,
    useCredits: 0,
  };
}

type BookingWindow = ReturnType<typeof createBookingWindow>;

describe("Chauffeur capacity and manual assignment", () => {
  let app: INestApplication;
  let bookingConfirmationService: BookingConfirmationService;
  let customerId: string;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let cookie: string;
  let ownerId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(EmailService)
      .useValue({ sendEmail: vi.fn().mockResolvedValue({ id: "email-1" }) })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    bookingConfirmationService = app.get(BookingConfirmationService);
    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);
    await app.init();
    await factory.createPlatformRates();

    const owner = await factory.createFleetOwner({
      isOwnerDriver: true,
      chauffeurApprovalStatus: "APPROVED",
    });
    ownerId = owner.id;
    const user = await factory.authenticateAndGetUser(uniqueEmail("capacity-hold"), "user");
    customerId = user.user.id;
    cookie = user.cookie;
    await databaseService.user.update({
      where: { id: customerId },
      data: {
        phoneNumber: "+2348012345678",
        phoneVerifiedAt: new Date(),
      },
    });

    vi.spyOn(app.get(FlutterwaveService), "createPaymentIntent").mockResolvedValue({
      paymentIntentId: "flw_pi_capacity",
      checkoutUrl: "https://checkout.flutterwave.com/pay/capacity",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  async function previewTotal(carId: string, window: BookingWindow): Promise<string> {
    const response = await request(app.getHttpServer())
      .post("/api/bookings/pricing-preview")
      .set("Cookie", cookie)
      .send({ ...window, carId });
    expect(response.status).toBe(HttpStatus.OK);
    return String(response.body.totalAmount);
  }

  function sendBooking(carId: string, window: BookingWindow, expectedTotalAmount: string) {
    return request(app.getHttpServer())
      .post("/api/bookings")
      .set("Cookie", cookie)
      .set("Idempotency-Key", randomUUID())
      .send({ ...window, carId, expectedTotalAmount });
  }

  it("lets only one of two overlapping bookings succeed when two cars share one chauffeur", async () => {
    const [carA, carB] = await Promise.all([
      factory.createCar(ownerId, { registrationNumber: `CAP-A-${randomUUID()}` }),
      factory.createCar(ownerId, { registrationNumber: `CAP-B-${randomUUID()}` }),
    ]);
    const window = createBookingWindow("2027-06-01T00:00:00.000Z", "2027-06-01T12:00:00.000Z");
    const expectedTotalAmount = await previewTotal(carA.id, window);
    const responses = await Promise.all([
      sendBooking(carA.id, window, expectedTotalAmount),
      sendBooking(carB.id, window, expectedTotalAmount),
    ]);
    const created = responses.filter((response) => response.status === HttpStatus.CREATED);
    const rejected = responses.filter((response) => response.status === HttpStatus.CONFLICT);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.body.errorCode).toBe("CAR_NOT_AVAILABLE");

    const held = await databaseService.booking.findMany({
      where: { chauffeurId: ownerId, carId: { in: [carA.id, carB.id] } },
      select: { id: true, status: true, chauffeurId: true },
    });
    expect(held).toEqual([
      {
        id: created[0]?.body.bookingId,
        status: "PENDING",
        chauffeurId: ownerId,
      },
    ]);
  });

  it("does not name a chauffeur for a fleet owner who assigns drivers manually", async () => {
    const owner = await factory.createFleetOwner({
      isOwnerDriver: false,
      fleetOwnerStatus: "APPROVED",
      hasOnboarded: true,
    });
    await factory.createChauffeur({
      fleetOwnerId: owner.id,
      chauffeurApprovalStatus: "APPROVED",
      chauffeurDisabledAt: null,
    });
    await factory.createChauffeur({
      fleetOwnerId: owner.id,
      chauffeurApprovalStatus: "APPROVED",
      chauffeurDisabledAt: null,
    });
    const [carA, carB] = await Promise.all([
      factory.createCar(owner.id, { registrationNumber: `MAN-A-${randomUUID()}` }),
      factory.createCar(owner.id, { registrationNumber: `MAN-B-${randomUUID()}` }),
    ]);
    const window = createBookingWindow("2034-05-02T00:00:00.000Z", "2034-05-02T12:00:00.000Z");
    const expectedTotalAmount = await previewTotal(carA.id, window);
    const responses = await Promise.all([
      sendBooking(carA.id, window, expectedTotalAmount),
      sendBooking(carB.id, window, expectedTotalAmount),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      HttpStatus.CREATED,
      HttpStatus.CREATED,
    ]);

    const held = await databaseService.booking.findMany({
      where: { carId: { in: [carA.id, carB.id] } },
      select: { chauffeurId: true, status: true },
    });
    expect(held).toEqual([
      { chauffeurId: null, status: "PENDING" },
      { chauffeurId: null, status: "PENDING" },
    ]);
  });

  it("keeps a free car hidden once unassigned trips use every chauffeur", async () => {
    const owner = await factory.createFleetOwner({
      isOwnerDriver: false,
      fleetOwnerStatus: "APPROVED",
      hasOnboarded: true,
    });
    await factory.createChauffeur({
      fleetOwnerId: owner.id,
      chauffeurApprovalStatus: "APPROVED",
      chauffeurDisabledAt: null,
    });
    const [carA, carB] = await Promise.all([
      factory.createCar(owner.id, { registrationNumber: `CAP-FLEET-A-${randomUUID()}` }),
      factory.createCar(owner.id, { registrationNumber: `CAP-FLEET-B-${randomUUID()}` }),
    ]);
    const window = createBookingWindow("2034-07-04T00:00:00.000Z", "2034-07-04T12:00:00.000Z");
    const expectedTotalAmount = await previewTotal(carA.id, window);
    const responses = await Promise.all([
      sendBooking(carA.id, window, expectedTotalAmount),
      sendBooking(carB.id, window, expectedTotalAmount),
    ]);
    const created = responses.filter((response) => response.status === HttpStatus.CREATED);
    const rejected = responses.filter((response) => response.status === HttpStatus.CONFLICT);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.body.errorCode).toBe("CAR_NOT_AVAILABLE");

    const held = await databaseService.booking.findUniqueOrThrow({
      where: { id: created[0]?.body.bookingId },
      select: { chauffeurId: true, status: true },
    });
    expect(held).toEqual({ chauffeurId: null, status: "PENDING" });

    const search = await request(app.getHttpServer()).get(
      "/api/cars/search?page=1&limit=50&from=2034-07-04T00:00:00.000Z&to=2034-07-04T00:00:00.000Z&bookingType=DAY&pickupTime=9:00%20AM",
    );
    expect(search.status).toBe(HttpStatus.OK);
    const visibleIds = search.body.cars.map((car: { id: string }) => car.id);
    expect(visibleIds).not.toContain(carA.id);
    expect(visibleIds).not.toContain(carB.id);
  });

  it("counts multiple assigned trips for one chauffeur as one occupied slot", async () => {
    const owner = await factory.createFleetOwner({
      isOwnerDriver: false,
      fleetOwnerStatus: "APPROVED",
      hasOnboarded: true,
    });
    const assignedChauffeur = await factory.createChauffeur({
      fleetOwnerId: owner.id,
      chauffeurApprovalStatus: "APPROVED",
      chauffeurDisabledAt: null,
    });
    await factory.createChauffeur({
      fleetOwnerId: owner.id,
      chauffeurApprovalStatus: "APPROVED",
      chauffeurDisabledAt: null,
    });
    const [bookedCarA, bookedCarB, availableCar] = await Promise.all([
      factory.createCar(owner.id, { registrationNumber: `SLOT-A-${randomUUID()}` }),
      factory.createCar(owner.id, { registrationNumber: `SLOT-B-${randomUUID()}` }),
      factory.createCar(owner.id, { registrationNumber: `SLOT-C-${randomUUID()}` }),
    ]);
    await factory.createBooking(customerId, bookedCarA.id, {
      chauffeurId: assignedChauffeur.id,
      startDate: new Date("2035-01-10T06:00:00.000Z"),
      endDate: new Date("2035-01-10T09:00:00.000Z"),
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
    await factory.createBooking(customerId, bookedCarB.id, {
      chauffeurId: assignedChauffeur.id,
      startDate: new Date("2035-01-10T11:00:00.000Z"),
      endDate: new Date("2035-01-10T14:00:00.000Z"),
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });

    const search = await request(app.getHttpServer()).get(
      "/api/cars/search?page=1&limit=50&from=2035-01-10T00:00:00.000Z&to=2035-01-10T00:00:00.000Z&bookingType=DAY&pickupTime=9:00%20AM",
    );
    expect(search.status).toBe(HttpStatus.OK);
    expect(search.body.cars.map((car: { id: string }) => car.id)).toContain(availableCar.id);

    const window = createBookingWindow("2035-01-10T00:00:00.000Z", "2035-01-10T12:00:00.000Z");
    const expectedTotalAmount = await previewTotal(availableCar.id, window);
    const response = await sendBooking(availableCar.id, window, expectedTotalAmount);

    expect(response.status).toBe(HttpStatus.CREATED);
    await expect(
      databaseService.booking.findUniqueOrThrow({
        where: { id: response.body.bookingId },
        select: { chauffeurId: true },
      }),
    ).resolves.toEqual({ chauffeurId: null });
  });

  it("completes checkout, payment confirmation, and idempotent manual assignment", async () => {
    const ownerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("manual-assignment-owner"),
      "fleetOwner",
      "web",
    );
    await databaseService.user.update({
      where: { id: ownerAuth.user.id },
      data: {
        fleetOwnerStatus: "APPROVED",
        hasOnboarded: true,
        isOwnerDriver: false,
      },
    });
    const chauffeur = await factory.createChauffeur({
      fleetOwnerId: ownerAuth.user.id,
      chauffeurApprovalStatus: "APPROVED",
      chauffeurDisabledAt: null,
    });
    const car = await factory.createCar(ownerAuth.user.id, {
      registrationNumber: `MANUAL-${randomUUID()}`,
    });
    const window = createBookingWindow("2036-02-10T00:00:00.000Z", "2036-02-10T12:00:00.000Z");
    const expectedTotalAmount = await previewTotal(car.id, window);
    const checkout = await sendBooking(car.id, window, expectedTotalAmount);

    expect(checkout.status).toBe(HttpStatus.CREATED);
    const bookingId = checkout.body.bookingId as string;
    const assignmentEventWhere = {
      bookingId,
      OR: [
        { dedupeKey: { startsWith: `chauffeur-assigned:${bookingId}:` } },
        { dedupeKey: { startsWith: `chauffeur-booking-assigned:${bookingId}:` } },
      ],
    };
    await expect(
      databaseService.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { chauffeurId: true, paymentStatus: true, status: true },
      }),
    ).resolves.toMatchObject({
      chauffeurId: null,
      paymentStatus: "UNPAID",
      status: "PENDING",
    });

    const payment = await factory.createPayment(bookingId, {
      amountExpected: checkout.body.totalAmount,
      amountCharged: checkout.body.totalAmount,
      status: "SUCCESSFUL",
    });
    const confirmedPayment = await databaseService.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    await expect(bookingConfirmationService.confirmFromPayment(confirmedPayment)).resolves.toBe(
      true,
    );
    await expect(
      databaseService.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { chauffeurId: true, paymentStatus: true, status: true },
      }),
    ).resolves.toMatchObject({
      chauffeurId: null,
      paymentStatus: "PAID",
      status: "CONFIRMED",
    });
    await expect(
      databaseService.notificationOutboxEvent.count({
        where: assignmentEventWhere,
      }),
    ).resolves.toBe(0);

    const assign = () =>
      request(app.getHttpServer())
        .patch(`/api/fleet-owner/bookings/${bookingId}/chauffeur`)
        .set("Cookie", ownerAuth.cookie)
        .send({ chauffeurId: chauffeur.id });

    const firstAssignment = await assign();
    expect(firstAssignment.status).toBe(HttpStatus.OK);
    expect(firstAssignment.body.chauffeur?.id ?? firstAssignment.body.chauffeurId).toBe(
      chauffeur.id,
    );
    await expect(
      databaseService.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { chauffeurId: true },
      }),
    ).resolves.toEqual({ chauffeurId: chauffeur.id });

    const assignmentEvents = await databaseService.notificationOutboxEvent.findMany({
      where: assignmentEventWhere,
      select: { userId: true },
    });
    expect(assignmentEvents).toHaveLength(2);
    expect(new Set(assignmentEvents.map((event) => event.userId))).toEqual(
      new Set([customerId, chauffeur.id]),
    );

    const secondAssignment = await assign();
    expect(secondAssignment.status).toBe(HttpStatus.OK);
    await expect(
      databaseService.notificationOutboxEvent.count({
        where: assignmentEventWhere,
      }),
    ).resolves.toBe(2);
  });
});
