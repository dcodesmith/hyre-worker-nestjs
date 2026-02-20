import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Dashboard E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let ownerId: string;
  let ownerCookie: string;
  let nonOwnerCookie: string;
  let createdPayoutIds: string[] = [];

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
      uniqueEmail("dashboard-owner"),
      "fleetOwner",
      "web",
    );
    ownerId = ownerAuth.user.id;
    ownerCookie = ownerAuth.cookie;
    await databaseService.user.update({
      where: { id: ownerId },
      data: { isOwnerDriver: true },
    });

    const nonOwnerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("dashboard-user"),
      "user",
    );
    nonOwnerCookie = nonOwnerAuth.cookie;

    const customer = await factory.createUser({ email: uniqueEmail("dashboard-customer") });
    const chauffeur = await factory.createChauffeur({ email: uniqueEmail("dashboard-chauffeur") });

    const ownerCar = await factory.createCar(ownerId, { registrationNumber: "DASH-001AA" });
    const ownerDriverBooking = await factory.createBooking(customer.id, ownerCar.id, {
      status: "COMPLETED",
      paymentStatus: "PAID",
      chauffeurId: ownerId,
      endDate: new Date("2026-02-01T10:00:00.000Z"),
    });
    const chauffeurBooking = await factory.createBooking(customer.id, ownerCar.id, {
      status: "COMPLETED",
      paymentStatus: "PAID",
      chauffeurId: chauffeur.id,
      endDate: new Date("2026-02-02T10:00:00.000Z"),
    });
    await factory.createBooking(customer.id, ownerCar.id, {
      status: "ACTIVE",
      paymentStatus: "UNPAID",
      chauffeurId: chauffeur.id,
      endDate: new Date("2026-02-03T10:00:00.000Z"),
    });
    await databaseService.booking.update({
      where: { id: ownerDriverBooking.id },
      data: {
        fleetOwnerPayoutAmountNet: 50000,
        platformFleetOwnerCommissionAmount: 5000,
      },
    });
    await databaseService.booking.update({
      where: { id: chauffeurBooking.id },
      data: {
        fleetOwnerPayoutAmountNet: 40000,
        platformFleetOwnerCommissionAmount: 4000,
      },
    });

    const paidOut = await factory.createPayoutTransaction(ownerId, {
      status: "PAID_OUT",
      amountToPay: 50000,
      amountPaid: 50000,
      completedAt: new Date("2026-02-03T10:00:00.000Z"),
    });
    const pending = await factory.createPayoutTransaction(ownerId, {
      status: "PENDING_DISBURSEMENT",
      amountToPay: 25000,
    });
    const failed = await factory.createPayoutTransaction(ownerId, {
      status: "FAILED",
      amountToPay: 10000,
    });
    createdPayoutIds = [paidOut.id, pending.id, failed.id];

    const otherOwner = await factory.createFleetOwner({
      email: uniqueEmail("dashboard-other-owner"),
    });
    await factory.createPayoutTransaction(otherOwner.id, {
      status: "PAID_OUT",
      amountToPay: 99999,
      amountPaid: 99999,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/dashboard/overview returns 401 when unauthenticated", async () => {
    const response = await request(app.getHttpServer()).get("/api/dashboard/overview");
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("GET /api/dashboard/overview returns 403 for non-fleet owner", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/dashboard/overview")
      .set("Cookie", nonOwnerCookie);
    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("GET /api/dashboard/overview returns owner-driver aware metrics", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/dashboard/overview")
      .set("Cookie", ownerCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.totalBookings).toBeGreaterThanOrEqual(3);
    expect(response.body.completedBookings).toBeGreaterThanOrEqual(2);
    expect(response.body.ownerDriverTrips).toBe(1);
    expect(response.body.chauffeurTrips).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/dashboard/earnings returns grouped earnings data", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/dashboard/earnings?range=custom&groupBy=day&from=2026-02-01&to=2026-02-28")
      .set("Cookie", ownerCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.totals.net).toBeGreaterThan(0);
    expect(Array.isArray(response.body.series)).toBe(true);
    expect(response.body.series.length).toBeGreaterThan(0);
  });

  it("GET /api/dashboard/payouts returns paginated owner payouts", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/dashboard/payouts?page=1&limit=10")
      .set("Cookie", ownerCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.total).toBeGreaterThanOrEqual(3);
    expect(response.body.items.length).toBeGreaterThan(0);

    const responseIds = response.body.items.map((item: { id: string }) => item.id);
    expect(responseIds.some((id: string) => createdPayoutIds.includes(id))).toBe(true);
  });

  it("GET /api/dashboard/payouts/summary returns payout aggregates", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/dashboard/payouts/summary")
      .set("Cookie", ownerCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.totalPaidOut).toBeGreaterThanOrEqual(50000);
    expect(response.body.pendingPayouts).toBeGreaterThanOrEqual(25000);
    expect(response.body.failedPayouts).toBeGreaterThanOrEqual(10000);
    expect(response.body.statusBreakdown).toHaveProperty("PAID_OUT");
  });
});
