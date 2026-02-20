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
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/cars returns 401 when unauthenticated", async () => {
    const response = await request(app.getHttpServer()).get("/api/cars");
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("GET /api/cars returns 403 when authenticated as non-fleet owner", async () => {
    const response = await request(app.getHttpServer()).get("/api/cars").set("Cookie", userCookie);
    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("POST /api/cars creates car for fleet owner", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/cars")
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

  it("GET /api/cars lists only requesting fleet owner's cars", async () => {
    await factory.createCar(secondOwnerId, { registrationNumber: "ABC-987ZZ" });

    const response = await request(app.getHttpServer()).get("/api/cars").set("Cookie", ownerCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);
    expect(response.body.every((car: { ownerId: string }) => car.ownerId === ownerId)).toBe(true);
  });

  it("GET /api/cars/:carId returns car detail for owner", async () => {
    const ownerCar = await databaseService.car.findFirstOrThrow({
      where: { ownerId, registrationNumber: "KJA-123AB" },
      select: { id: true },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/cars/${ownerCar.id}`)
      .set("Cookie", ownerCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.id).toBe(ownerCar.id);
    expect(response.body.ownerId).toBe(ownerId);
  });

  it("GET /api/cars/:carId returns 404 for other fleet owner's car", async () => {
    const ownerCar = await databaseService.car.findFirstOrThrow({
      where: { ownerId, registrationNumber: "KJA-123AB" },
      select: { id: true },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/cars/${ownerCar.id}`)
      .set("Cookie", secondOwnerCookie);

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
  });

  it("PATCH /api/cars/:carId updates owner car", async () => {
    const ownerCar = await databaseService.car.findFirstOrThrow({
      where: { ownerId, registrationNumber: "KJA-123AB" },
      select: { id: true },
    });

    const response = await request(app.getHttpServer())
      .patch(`/api/cars/${ownerCar.id}`)
      .set("Cookie", ownerCookie)
      .send({
        dayRate: 55000,
        status: "HOLD",
      });

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.dayRate).toBe(55000);
    expect(response.body.status).toBe("HOLD");
  });

  it("PATCH /api/cars/:carId returns 404 when updating another owner's car", async () => {
    const ownerCar = await databaseService.car.findFirstOrThrow({
      where: { ownerId, registrationNumber: "KJA-123AB" },
      select: { id: true },
    });

    const response = await request(app.getHttpServer())
      .patch(`/api/cars/${ownerCar.id}`)
      .set("Cookie", secondOwnerCookie)
      .send({ status: "AVAILABLE" });

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
  });
});
