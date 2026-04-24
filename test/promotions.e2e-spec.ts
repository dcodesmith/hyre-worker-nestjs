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

/**
 * E2E coverage for the fleet-owner promotions surface:
 *   - Auth / role enforcement
 *   - Validation (date ordering, discount bounds, scope contract)
 *   - Create success (car-scoped + fleet-wide)
 *   - Overlap rejection
 *   - Deactivate (soft-disable)
 *   - List returns promotions with car relation populated
 *   - Cross-owner isolation
 */
describe("Fleet Owner Promotions E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let ownerCookie: string;
  let ownerId: string;
  let secondOwnerCookie: string;
  let secondOwnerId: string;
  let userCookie: string;
  let ownerCarId: string;
  let otherOwnerCarId: string;

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
      uniqueEmail("promo-owner"),
      "fleetOwner",
      "web",
    );
    ownerCookie = ownerAuth.cookie;
    ownerId = ownerAuth.user.id;

    const secondOwnerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("promo-owner-2"),
      "fleetOwner",
      "web",
    );
    secondOwnerCookie = secondOwnerAuth.cookie;
    secondOwnerId = secondOwnerAuth.user.id;

    const userAuth = await factory.authenticateAndGetUser(uniqueEmail("promo-user"), "user");
    userCookie = userAuth.cookie;

    await databaseService.user.update({
      where: { id: ownerId },
      data: { fleetOwnerStatus: "APPROVED", hasOnboarded: true },
    });
    await databaseService.user.update({
      where: { id: secondOwnerId },
      data: { fleetOwnerStatus: "APPROVED", hasOnboarded: true },
    });

    const ownerCar = await factory.createCar(ownerId, {
      registrationNumber: "PRM-001AA",
      approvalStatus: "APPROVED",
      status: "AVAILABLE",
    });
    ownerCarId = ownerCar.id;

    const otherCar = await factory.createCar(secondOwnerId, {
      registrationNumber: "PRM-002BB",
      approvalStatus: "APPROVED",
      status: "AVAILABLE",
    });
    otherOwnerCarId = otherCar.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe("Auth / role", () => {
    it("rejects unauthenticated requests to list endpoint", async () => {
      const response = await request(app.getHttpServer()).get("/api/fleet-owner/promotions");
      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("rejects unauthenticated requests to create endpoint", async () => {
      const response = await request(app.getHttpServer()).post("/api/fleet-owner/promotions").send({
        scope: "FLEET",
        discountValue: 10,
        startDate: "2027-01-01",
        endDate: "2027-01-05",
      });
      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("rejects non fleet-owners", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/fleet-owner/promotions")
        .set("Cookie", userCookie);
      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });
  });

  describe("POST /api/fleet-owner/promotions", () => {
    it("creates a car-specific promotion", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          name: "Car Boost",
          scope: "CAR",
          carId: ownerCarId,
          discountValue: 20,
          startDate: "2027-01-10",
          endDate: "2027-01-12",
        });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body.id).toBeDefined();
      expect(response.body.carId).toBe(ownerCarId);
      expect(response.body.ownerId).toBe(ownerId);
      expect(Number(response.body.discountValue)).toBe(20);
      expect(response.body.isActive).toBe(true);
    });

    it("creates a fleet-wide promotion when scope is FLEET", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          scope: "FLEET",
          discountValue: 15,
          startDate: "2027-02-01",
          endDate: "2027-02-05",
        });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body.carId).toBeNull();
    });

    it("rejects end date before start date", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          scope: "FLEET",
          discountValue: 10,
          startDate: "2027-03-10",
          endDate: "2027-03-05",
        });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("rejects discount below 1%", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          scope: "FLEET",
          discountValue: 0,
          startDate: "2027-04-01",
          endDate: "2027-04-05",
        });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("rejects discount above 50%", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          scope: "FLEET",
          discountValue: 60,
          startDate: "2027-04-01",
          endDate: "2027-04-05",
        });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("rejects malformed date strings", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          scope: "FLEET",
          discountValue: 10,
          startDate: "04/10/2027",
          endDate: "04/12/2027",
        });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("rejects targeting a car outside the caller's fleet", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          scope: "CAR",
          carId: otherOwnerCarId,
          discountValue: 10,
          startDate: "2027-05-01",
          endDate: "2027-05-05",
        });

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });

    it("rejects overlapping same-scope promotions", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          name: "Overlap",
          scope: "CAR",
          carId: ownerCarId,
          discountValue: 10,
          startDate: "2027-01-11",
          endDate: "2027-01-13",
        });

      expect(response.status).toBe(HttpStatus.CONFLICT);
    });

    it("allows car-scoped and fleet-wide promotions to coexist on overlapping windows", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          scope: "CAR",
          carId: ownerCarId,
          discountValue: 10,
          startDate: "2027-02-02",
          endDate: "2027-02-03",
        });

      expect(response.status).toBe(HttpStatus.CREATED);
    });
  });

  describe("GET /api/fleet-owner/promotions", () => {
    it("returns only caller's promotions with car relation populated", async () => {
      const http = app.getHttpServer();

      // Deterministic seed (2028 windows avoid overlap with earlier 2027 scenarios in this file).
      const seedFleet = await request(http)
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          name: "seed-list-fleet",
          scope: "FLEET",
          discountValue: 10,
          startDate: "2028-10-01",
          endDate: "2028-10-05",
        });
      expect(seedFleet.status).toBe(HttpStatus.CREATED);
      const fleetPromotionId = seedFleet.body.id as string;

      const seedCarA = await request(http)
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          name: "seed-list-car-a",
          scope: "CAR",
          carId: ownerCarId,
          discountValue: 11,
          startDate: "2028-10-10",
          endDate: "2028-10-12",
        });
      expect(seedCarA.status).toBe(HttpStatus.CREATED);
      const carPromotionIdA = seedCarA.body.id as string;

      const seedCarB = await request(http)
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          name: "seed-list-car-b",
          scope: "CAR",
          carId: ownerCarId,
          discountValue: 12,
          startDate: "2028-10-20",
          endDate: "2028-10-22",
        });
      expect(seedCarB.status).toBe(HttpStatus.CREATED);
      const carPromotionIdB = seedCarB.body.id as string;

      const response = await request(http)
        .get("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.every((p: { ownerId: string }) => p.ownerId === ownerId)).toBe(true);

      expect(response.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: fleetPromotionId,
            ownerId,
            carId: null,
            car: null,
          }),
          expect.objectContaining({
            id: carPromotionIdA,
            ownerId,
            carId: ownerCarId,
            car: expect.objectContaining({ registrationNumber: "PRM-001AA" }),
          }),
          expect.objectContaining({
            id: carPromotionIdB,
            ownerId,
            carId: ownerCarId,
            car: expect.objectContaining({ registrationNumber: "PRM-001AA" }),
          }),
        ]),
      );
    });

    it("isolates promotions between owners", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/fleet-owner/promotions")
        .set("Cookie", secondOwnerCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.every((p: { ownerId: string }) => p.ownerId === secondOwnerId)).toBe(
        true,
      );
    });
  });

  describe("POST /api/fleet-owner/promotions/:promotionId/deactivate", () => {
    it("soft-disables a promotion owned by the caller", async () => {
      const created = await request(app.getHttpServer())
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          scope: "FLEET",
          discountValue: 25,
          startDate: "2027-06-01",
          endDate: "2027-06-05",
        });
      expect(created.status).toBe(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .post(`/api/fleet-owner/promotions/${created.body.id}/deactivate`)
        .set("Cookie", ownerCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.isActive).toBe(false);

      const secondDeactivate = await request(app.getHttpServer())
        .post(`/api/fleet-owner/promotions/${created.body.id}/deactivate`)
        .set("Cookie", ownerCookie);

      expect(secondDeactivate.status).toBe(HttpStatus.OK);
      expect(secondDeactivate.body.isActive).toBe(false);
    });

    it("returns 404 when deactivating a promotion owned by another fleet owner", async () => {
      const created = await request(app.getHttpServer())
        .post("/api/fleet-owner/promotions")
        .set("Cookie", ownerCookie)
        .send({
          scope: "FLEET",
          discountValue: 10,
          startDate: "2027-07-01",
          endDate: "2027-07-05",
        });
      expect(created.status).toBe(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .post(`/api/fleet-owner/promotions/${created.body.id}/deactivate`)
        .set("Cookie", secondOwnerCookie);

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });
  });
});
