import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { StorageService } from "../src/modules/storage/storage.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Cars E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let ownerCookie: string;
  let ownerId: string;
  let secondOwnerCookie: string;
  let secondOwnerId: string;
  let userCookie: string;
  let publicCarId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(StorageService)
      .useValue({
        uploadBuffer: vi.fn().mockImplementation(async (_buffer: Buffer, key: string) => {
          return `https://cdn.tripdly.test/${key}`;
        }),
        deleteObjectByKey: vi.fn().mockResolvedValue(undefined),
      })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);
    await app.init();

    const ownerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("cars-owner"),
      "fleetOwner",
      "web",
    );
    ownerCookie = ownerAuth.cookie;
    ownerId = ownerAuth.user.id;

    const secondOwnerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("cars-owner-2"),
      "fleetOwner",
      "web",
    );
    secondOwnerCookie = secondOwnerAuth.cookie;
    secondOwnerId = secondOwnerAuth.user.id;

    const userAuth = await factory.authenticateAndGetUser(uniqueEmail("cars-user"), "user");
    userCookie = userAuth.cookie;

    await databaseService.user.update({
      where: { id: ownerId },
      data: { fleetOwnerStatus: "APPROVED", hasOnboarded: true },
    });

    const publicCar = await factory.createCar(ownerId, {
      registrationNumber: "PUB-123AA",
      approvalStatus: "APPROVED",
      status: "AVAILABLE",
    });
    publicCarId = publicCar.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/fleet-owner/cars returns 401 when unauthenticated", async () => {
    const response = await request(app.getHttpServer()).get("/api/fleet-owner/cars");
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("GET /api/fleet-owner/cars returns 403 when authenticated as non-fleet owner", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/fleet-owner/cars")
      .set("Cookie", userCookie);
    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("POST /api/fleet-owner/cars creates car for fleet owner", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/fleet-owner/cars")
      .set("Cookie", ownerCookie)
      .field("make", "Toyota")
      .field("model", "Camry")
      .field("year", "2022")
      .field("color", "Black")
      .field("registrationNumber", "KJA-123AB")
      .field("dayRate", "50000")
      .field("hourlyRate", "5000")
      .field("nightRate", "60000")
      .field("fullDayRate", "100000")
      .field("airportPickupRate", "30000")
      .field("pricingIncludesFuel", "false")
      .field("fuelUpgradeRate", "10000")
      .field("vehicleType", "SEDAN")
      .field("serviceTier", "STANDARD")
      .field("passengerCapacity", "4")
      .attach("images", Buffer.from("fake-image"), {
        filename: "car.jpg",
        contentType: "image/jpeg",
      })
      .attach("motCertificate", Buffer.from("%PDF-1.4 test"), {
        filename: "mot.pdf",
        contentType: "application/pdf",
      })
      .attach("insuranceCertificate", Buffer.from("%PDF-1.4 insurance"), {
        filename: "insurance.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body.ownerId).toBe(ownerId);
    expect(response.body.registrationNumber).toBe("KJA-123AB");
    expect(response.body.images).toHaveLength(1);
    expect(response.body.documents).toHaveLength(2);
  });

  it("GET /api/fleet-owner/cars lists only requesting fleet owner's cars", async () => {
    await factory.createCar(secondOwnerId, { registrationNumber: "ABC-987ZZ" });

    const response = await request(app.getHttpServer())
      .get("/api/fleet-owner/cars")
      .set("Cookie", ownerCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);
    expect(response.body.every((car: { ownerId: string }) => car.ownerId === ownerId)).toBe(true);
  });

  it("GET /api/fleet-owner/cars/:carId returns car detail for owner", async () => {
    const ownerCar = await databaseService.car.findFirstOrThrow({
      where: { ownerId, registrationNumber: "KJA-123AB" },
      select: { id: true },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/fleet-owner/cars/${ownerCar.id}`)
      .set("Cookie", ownerCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.id).toBe(ownerCar.id);
    expect(response.body.ownerId).toBe(ownerId);
  });

  it("GET /api/fleet-owner/cars/:carId returns 404 for other fleet owner's car", async () => {
    const ownerCar = await databaseService.car.findFirstOrThrow({
      where: { ownerId, registrationNumber: "KJA-123AB" },
      select: { id: true },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/fleet-owner/cars/${ownerCar.id}`)
      .set("Cookie", secondOwnerCookie);

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
  });

  it("PATCH /api/fleet-owner/cars/:carId updates owner car", async () => {
    const ownerCar = await databaseService.car.findFirstOrThrow({
      where: { ownerId, registrationNumber: "KJA-123AB" },
      select: { id: true },
    });

    const response = await request(app.getHttpServer())
      .patch(`/api/fleet-owner/cars/${ownerCar.id}`)
      .set("Cookie", ownerCookie)
      .send({
        dayRate: 55000,
        status: "HOLD",
      });

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.dayRate).toBe(55000);
    expect(response.body.status).toBe("HOLD");
  });

  it("PATCH /api/fleet-owner/cars/:carId returns 404 when updating another owner's car", async () => {
    const ownerCar = await databaseService.car.findFirstOrThrow({
      where: { ownerId, registrationNumber: "KJA-123AB" },
      select: { id: true },
    });

    const response = await request(app.getHttpServer())
      .patch(`/api/fleet-owner/cars/${ownerCar.id}`)
      .set("Cookie", secondOwnerCookie)
      .send({ status: "AVAILABLE" });

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
  });

  it("GET /api/cars/categories returns public categories payload", async () => {
    const response = await request(app.getHttpServer()).get("/api/cars/categories?limit=20");

    expect(response.status).toBe(HttpStatus.OK);
    expect(Array.isArray(response.body.categories)).toBe(true);
    expect(Array.isArray(response.body.allCars)).toBe(true);
    expect(response.body.total).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/cars/search returns public search payload", async () => {
    const response = await request(app.getHttpServer()).get("/api/cars/search?page=1&limit=12");

    expect(response.status).toBe(HttpStatus.OK);
    expect(Array.isArray(response.body.cars)).toBe(true);
    expect(response.body.pagination.page).toBe(1);
    expect(response.body.pagination.limit).toBe(12);
    expect(response.body.pagination.total).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/cars/:carId returns approved public car detail", async () => {
    const response = await request(app.getHttpServer()).get(`/api/cars/${publicCarId}`);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.id).toBe(publicCarId);
  });

  it("GET /api/cars/:carId returns 404 for non-approved car", async () => {
    const pendingCar = await factory.createCar(ownerId, {
      registrationNumber: "PUB-404AA",
      approvalStatus: "PENDING",
      status: "AVAILABLE",
    });

    const response = await request(app.getHttpServer()).get(`/api/cars/${pendingCar.id}`);

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
  });
});
