import { randomUUID } from "node:crypto";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ProviderVerificationStatus } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { PremblyService } from "../src/modules/prembly/prembly.service";
import { StorageService } from "../src/modules/storage/storage.service";
import { VerificationErrorCode } from "../src/modules/verification/verification.error";
import { TestDataFactory, uniqueEmail } from "./helpers";

const PDF_BUFFER = Buffer.from("%PDF-1.4 test-certificate");
const IMAGE_BUFFER = Buffer.from("fake-jpeg-bytes");
const FUTURE_INSURANCE_EXPIRY = new Date("2099-12-31T00:00:00.000Z");

describe("Vehicle verification E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let ownerCookie: string;
  let ownerId: string;
  let secondOwnerCookie: string;
  let userCookie: string;
  let adminCookie: string;
  let plateSequence = 100;
  let chassisSequence = 200000;
  let clientIp = "203.0.113.10";
  let ipSequence = 10;

  const premblyService = {
    verifyPlate: vi.fn(),
    verifyVin: vi.fn(),
    verifyInsurance: vi.fn(),
  };

  const uniquePlate = () => {
    plateSequence += 1;
    return `VVF-${plateSequence}AB`;
  };

  const uniqueChassis = () => {
    chassisSequence += 1;
    return `1HGCM82633A${String(chassisSequence).padStart(6, "0")}`;
  };

  const mockSuccessfulPrembly = (
    plateNumber: string,
    year = 2020,
    chassisNumber = uniqueChassis(),
  ) => {
    premblyService.verifyPlate.mockResolvedValue({
      plateNumber,
      chassisNumber,
      make: "Toyota",
      model: "Camry",
      color: "Black",
      passengerCapacity: 5,
      reference: "plate-ref",
    });
    premblyService.verifyVin.mockResolvedValue({
      year,
      make: "Toyota",
      model: "Camry",
      passengerCapacity: 5,
      reference: "vin-ref",
    });
    return chassisNumber;
  };

  const withOwner = (req: request.Test, cookie = ownerCookie) =>
    req.set("Cookie", cookie).set("X-Forwarded-For", clientIp);

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
      .overrideProvider(PremblyService)
      .useValue(premblyService)
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);
    await app.init();

    const ownerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("verify-owner"),
      "fleetOwner",
      "web",
    );
    ownerCookie = ownerAuth.cookie;
    ownerId = ownerAuth.user.id;

    const secondOwnerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("verify-owner-2"),
      "fleetOwner",
      "web",
    );
    secondOwnerCookie = secondOwnerAuth.cookie;

    const userAuth = await factory.authenticateAndGetUser(uniqueEmail("verify-user"), "user");
    userCookie = userAuth.cookie;

    const adminAuth = await factory.createAuthenticatedAdmin(uniqueEmail("verify-admin"));
    adminCookie = adminAuth.cookie;

    await databaseService.user.updateMany({
      where: { id: { in: [ownerId, secondOwnerAuth.user.id] } },
      data: {
        fleetOwnerStatus: "APPROVED",
        hasOnboarded: true,
        emailVerified: true,
        phoneNumber: "+2348012345678",
        phoneVerifiedAt: new Date(),
      },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ipSequence += 1;
    clientIp = `198.51.100.${(ipSequence % 200) + 1}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /api/fleet-owner/vehicle-verifications returns 401 when unauthenticated", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/fleet-owner/vehicle-verifications")
      .send({ plateNumber: uniquePlate() });

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(premblyService.verifyPlate).not.toHaveBeenCalled();
  });

  it("POST /api/fleet-owner/vehicle-verifications returns 403 for a non-fleet owner", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/fleet-owner/vehicle-verifications")
      .set("Cookie", userCookie)
      .set("Idempotency-Key", randomUUID())
      .send({ plateNumber: uniquePlate() });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
    expect(premblyService.verifyPlate).not.toHaveBeenCalled();
  });

  it("rejects a missing Idempotency-Key and an invalid plate", async () => {
    const missingKey = await withOwner(
      request(app.getHttpServer()).post("/api/fleet-owner/vehicle-verifications"),
    ).send({ plateNumber: uniquePlate() });
    const invalidPlate = await withOwner(
      request(app.getHttpServer()).post("/api/fleet-owner/vehicle-verifications"),
    )
      .set("Idempotency-Key", randomUUID())
      .send({ plateNumber: "not-a-plate" });

    expect(missingKey.status).toBe(HttpStatus.BAD_REQUEST);
    expect(missingKey.body.errorCode).toBe("VALIDATION_ERROR");
    expect(invalidPlate.status).toBe(HttpStatus.BAD_REQUEST);
    expect(premblyService.verifyPlate).not.toHaveBeenCalled();
  });

  it("creates a verification, replays the same key, then creates a draft car once", async () => {
    const plateNumber = uniquePlate();
    const chassisNumber = mockSuccessfulPrembly(plateNumber);
    const idempotencyKey = randomUUID();

    const created = await withOwner(
      request(app.getHttpServer()).post("/api/fleet-owner/vehicle-verifications"),
    )
      .set("Idempotency-Key", idempotencyKey)
      .send({ plateNumber });

    expect(created.status).toBe(HttpStatus.CREATED);
    expect(created.body).toMatchObject({
      status: ProviderVerificationStatus.SUCCEEDED,
      vehicle: {
        plateNumber: plateNumber.replace("-", ""),
        chassisNumber,
        make: "Toyota",
        model: "Camry",
        year: 2020,
      },
      eligibility: { isEligible: true, reasons: [] },
      carId: null,
    });

    const replay = await withOwner(
      request(app.getHttpServer()).post("/api/fleet-owner/vehicle-verifications"),
    )
      .set("Idempotency-Key", idempotencyKey)
      .send({ plateNumber });

    expect(replay.status).toBe(HttpStatus.CREATED);
    expect(replay.body.id).toBe(created.body.id);
    expect(premblyService.verifyPlate).toHaveBeenCalledTimes(1);
    expect(premblyService.verifyVin).toHaveBeenCalledTimes(1);

    const otherOwner = await request(app.getHttpServer())
      .get(`/api/fleet-owner/vehicle-verifications/${created.body.id}`)
      .set("Cookie", secondOwnerCookie);
    expect(otherOwner.status).toBe(HttpStatus.NOT_FOUND);

    const draft = await request(app.getHttpServer())
      .post(`/api/fleet-owner/vehicle-verifications/${created.body.id}/car`)
      .set("Cookie", ownerCookie);

    expect(draft.status).toBe(HttpStatus.CREATED);
    expect(draft.body).toMatchObject({
      ownerId,
      registrationNumber: plateNumber.replace("-", ""),
      chassisNumber,
      make: "Toyota",
      model: "Camry",
      year: 2020,
      hourlyRate: null,
      dayRate: null,
      nightRate: null,
      fullDayRate: null,
      airportPickupRate: null,
    });

    const reused = await request(app.getHttpServer())
      .post(`/api/fleet-owner/vehicle-verifications/${created.body.id}/car`)
      .set("Cookie", ownerCookie);

    expect(reused.status).toBe(HttpStatus.CONFLICT);
    expect(reused.body.errorCode).toBe("VEHICLE_VERIFICATION_ALREADY_USED");
  });

  it("conflicts when the same idempotency key is reused with a different plate", async () => {
    const firstPlate = uniquePlate();
    const secondPlate = uniquePlate();
    const idempotencyKey = randomUUID();
    mockSuccessfulPrembly(firstPlate);

    const first = await withOwner(
      request(app.getHttpServer()).post("/api/fleet-owner/vehicle-verifications"),
    )
      .set("Idempotency-Key", idempotencyKey)
      .send({ plateNumber: firstPlate });
    const conflict = await withOwner(
      request(app.getHttpServer()).post("/api/fleet-owner/vehicle-verifications"),
    )
      .set("Idempotency-Key", idempotencyKey)
      .send({ plateNumber: secondPlate });

    expect(first.status).toBe(HttpStatus.CREATED);
    expect(conflict.status).toBe(HttpStatus.CONFLICT);
    expect(conflict.body.errorCode).toBe("VERIFICATION_IDEMPOTENCY_KEY_REUSED");
    expect(premblyService.verifyPlate).toHaveBeenCalledTimes(1);
  });

  it("returns 410 for an expired verification and 422 for an under-2015 vehicle", async () => {
    const expired = await databaseService.vehicleVerification.create({
      data: {
        ownerId,
        idempotencyKey: `expired-${randomUUID()}`,
        requestHash: randomUUID(),
        plateNumber: uniquePlate().replace("-", ""),
        chassisNumber: "1HGCM82633A111111",
        make: "Toyota",
        model: "Camry",
        year: 2020,
        passengerCapacity: 5,
        status: ProviderVerificationStatus.SUCCEEDED,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const expiredResponse = await request(app.getHttpServer())
      .post(`/api/fleet-owner/vehicle-verifications/${expired.id}/car`)
      .set("Cookie", ownerCookie);

    expect(expiredResponse.status).toBe(HttpStatus.GONE);
    expect(expiredResponse.body.errorCode).toBe("VEHICLE_VERIFICATION_EXPIRED");

    const oldPlate = uniquePlate();
    mockSuccessfulPrembly(oldPlate, 2014);
    const ineligible = await withOwner(
      request(app.getHttpServer()).post("/api/fleet-owner/vehicle-verifications"),
    )
      .set("Idempotency-Key", randomUUID())
      .send({ plateNumber: oldPlate });
    const ineligibleCar = await request(app.getHttpServer())
      .post(`/api/fleet-owner/vehicle-verifications/${ineligible.body.id}/car`)
      .set("Cookie", ownerCookie);

    expect(ineligible.status).toBe(HttpStatus.CREATED);
    expect(ineligible.body.eligibility).toEqual({
      isEligible: false,
      reasons: ["VEHICLE_YEAR_BELOW_MINIMUM"],
    });
    expect(ineligibleCar.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(ineligibleCar.body.errorCode).toBe("VEHICLE_NOT_ELIGIBLE");
  });

  it("POST /api/fleet-owner/cars returns 410 and directs clients to vehicle-verifications", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/fleet-owner/cars")
      .set("Cookie", ownerCookie);

    expect(response.status).toBe(HttpStatus.GONE);
    expect(response.body.detail).toContain("vehicle-verifications");
  });

  async function createVerifiedDraftCar() {
    const plateNumber = uniquePlate();
    const chassisNumber = mockSuccessfulPrembly(plateNumber);
    const created = await withOwner(
      request(app.getHttpServer()).post("/api/fleet-owner/vehicle-verifications"),
    )
      .set("Idempotency-Key", randomUUID())
      .send({ plateNumber });
    const draft = await request(app.getHttpServer())
      .post(`/api/fleet-owner/vehicle-verifications/${created.body.id}/car`)
      .set("Cookie", ownerCookie);

    expect(created.status).toBe(HttpStatus.CREATED);
    expect(draft.status).toBe(HttpStatus.CREATED);
    return {
      plateNumber: plateNumber.replace("-", ""),
      chassisNumber,
      carId: draft.body.id as string,
    };
  }

  const pricingBody = {
    hourlyRate: 5000,
    dayRate: 50_000,
    nightRate: 60_000,
    fullDayRate: 100_000,
    airportPickupRate: 30_000,
    pricingIncludesFuel: true,
    vehicleType: "SEDAN",
    serviceTier: "STANDARD",
  };

  async function uploadDraftAssets(carId: string) {
    const documents = await request(app.getHttpServer())
      .post(`/api/fleet-owner/cars/${carId}/documents`)
      .set("Cookie", ownerCookie)
      .attach("motCertificate", PDF_BUFFER, { filename: "mot.pdf", contentType: "application/pdf" })
      .attach("insuranceCertificate", PDF_BUFFER, {
        filename: "insurance.pdf",
        contentType: "application/pdf",
      });
    const images = await request(app.getHttpServer())
      .post(`/api/fleet-owner/cars/${carId}/images`)
      .set("Cookie", ownerCookie)
      .attach("images", IMAGE_BUFFER, { filename: "car.jpg", contentType: "image/jpeg" });
    const pricing = await request(app.getHttpServer())
      .patch(`/api/fleet-owner/cars/${carId}/pricing`)
      .set("Cookie", ownerCookie)
      .send(pricingBody);

    expect(documents.status).toBe(HttpStatus.CREATED);
    expect(images.status).toBe(HttpStatus.CREATED);
    expect(pricing.status).toBe(HttpStatus.OK);
    return { documents, images, pricing };
  }

  function mockSuccessfulInsurance(plateNumber: string, chassisNumber: string) {
    premblyService.verifyInsurance.mockResolvedValue({
      policyNumber: "POL-123",
      policyStatus: "Active",
      plateNumbers: [plateNumber],
      chassisNumber,
      expiresAt: FUTURE_INSURANCE_EXPIRY,
      reference: "ins-ref",
    });
  }

  it("persists future active insurance and isolates it from another owner", async () => {
    const { plateNumber, chassisNumber, carId } = await createVerifiedDraftCar();
    mockSuccessfulInsurance(plateNumber, chassisNumber);

    const created = await withOwner(
      request(app.getHttpServer()).post(`/api/fleet-owner/cars/${carId}/insurance-verifications`),
    )
      .set("Idempotency-Key", randomUUID())
      .send({ policyNumber: "pol-123" });

    expect(created.status).toBe(HttpStatus.CREATED);
    expect(created.body).toMatchObject({
      carId,
      status: ProviderVerificationStatus.SUCCEEDED,
      policyNumber: "POL-123",
      policyStatus: "Active",
      providerRef: "ins-ref",
    });
    expect(new Date(created.body.policyExpiresAt).toISOString()).toBe(
      FUTURE_INSURANCE_EXPIRY.toISOString(),
    );

    const otherOwner = await withOwner(
      request(app.getHttpServer()).post(`/api/fleet-owner/cars/${carId}/insurance-verifications`),
      secondOwnerCookie,
    )
      .set("Idempotency-Key", randomUUID())
      .send({ policyNumber: "POL-999" });
    expect(otherOwner.status).toBe(HttpStatus.NOT_FOUND);

    const replayKey = randomUUID();
    mockSuccessfulInsurance(plateNumber, chassisNumber);
    const first = await withOwner(
      request(app.getHttpServer()).post(`/api/fleet-owner/cars/${carId}/insurance-verifications`),
    )
      .set("Idempotency-Key", replayKey)
      .send({ policyNumber: "POL-456" });
    const replay = await withOwner(
      request(app.getHttpServer()).post(`/api/fleet-owner/cars/${carId}/insurance-verifications`),
    )
      .set("Idempotency-Key", replayKey)
      .send({ policyNumber: "POL-456" });
    const conflict = await withOwner(
      request(app.getHttpServer()).post(`/api/fleet-owner/cars/${carId}/insurance-verifications`),
    )
      .set("Idempotency-Key", replayKey)
      .send({ policyNumber: "POL-789" });

    expect(first.status).toBe(HttpStatus.CREATED);
    expect(replay.status).toBe(HttpStatus.CREATED);
    expect(replay.body.id).toBe(first.body.id);
    expect(conflict.status).toBe(HttpStatus.CONFLICT);
    expect(conflict.body.errorCode).toBe("VERIFICATION_IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects active but expired insurance and marks the request failed", async () => {
    const { plateNumber, chassisNumber, carId } = await createVerifiedDraftCar();
    premblyService.verifyInsurance.mockResolvedValueOnce({
      policyNumber: "POL-EXPIRED",
      policyStatus: "Active",
      plateNumbers: [plateNumber],
      chassisNumber,
      expiresAt: new Date(Date.now() - 60_000),
      reference: "ins-expired",
    });

    const response = await withOwner(
      request(app.getHttpServer()).post(`/api/fleet-owner/cars/${carId}/insurance-verifications`),
    )
      .set("Idempotency-Key", randomUUID())
      .send({ policyNumber: "POL-EXPIRED" });

    expect(response.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(response.body.errorCode).toBe("INSURANCE_INACTIVE");

    const stored = await databaseService.insuranceVerification.findFirst({
      where: { carId, policyNumber: "POL-EXPIRED" },
    });
    expect(stored?.status).toBe(ProviderVerificationStatus.FAILED);
    expect(stored?.failureReason).toBe(VerificationErrorCode.INSURANCE_INACTIVE);
  });

  it("requires unexpired insurance before a verified draft can be submitted", async () => {
    const { plateNumber, chassisNumber, carId } = await createVerifiedDraftCar();
    await uploadDraftAssets(carId);

    const missingInsurance = await request(app.getHttpServer())
      .post(`/api/fleet-owner/cars/${carId}/submissions`)
      .set("Cookie", ownerCookie);
    expect(missingInsurance.status).toBe(HttpStatus.CONFLICT);
    expect(missingInsurance.body.errorCode).toBe("CAR_SUBMISSION_REQUIREMENTS_NOT_MET");
    expect(missingInsurance.body.details.requirements.hasInsuranceVerification).toBe(false);

    await databaseService.insuranceVerification.create({
      data: {
        ownerId,
        carId,
        idempotencyKey: `expired-ins-${randomUUID()}`,
        requestHash: randomUUID(),
        policyNumber: "POL-PAST",
        policyStatus: "Active",
        policyExpiresAt: new Date(Date.now() - 60_000),
        status: ProviderVerificationStatus.SUCCEEDED,
      },
    });

    const expiredInsurance = await request(app.getHttpServer())
      .post(`/api/fleet-owner/cars/${carId}/submissions`)
      .set("Cookie", ownerCookie);
    expect(expiredInsurance.status).toBe(HttpStatus.CONFLICT);
    expect(expiredInsurance.body.details.requirements.hasInsuranceVerification).toBe(false);

    mockSuccessfulInsurance(plateNumber, chassisNumber);
    const verified = await withOwner(
      request(app.getHttpServer()).post(`/api/fleet-owner/cars/${carId}/insurance-verifications`),
    )
      .set("Idempotency-Key", randomUUID())
      .send({ policyNumber: "POL-FUTURE" });
    expect(verified.status).toBe(HttpStatus.CREATED);

    const submitted = await request(app.getHttpServer())
      .post(`/api/fleet-owner/cars/${carId}/submissions`)
      .set("Cookie", ownerCookie);
    expect(submitted.status).toBe(HttpStatus.CREATED);
    expect(submitted.body).toMatchObject({
      success: true,
      requirements: {
        hasDocuments: true,
        hasImages: true,
        hasPricing: true,
        hasInsuranceVerification: true,
      },
    });
  });

  it("completes staged onboarding through admin review and publish", async () => {
    const { plateNumber, chassisNumber, carId } = await createVerifiedDraftCar();
    const assets = await uploadDraftAssets(carId);
    mockSuccessfulInsurance(plateNumber, chassisNumber);

    const insurance = await withOwner(
      request(app.getHttpServer()).post(`/api/fleet-owner/cars/${carId}/insurance-verifications`),
    )
      .set("Idempotency-Key", randomUUID())
      .send({ policyNumber: "POL-LIVE" });
    expect(insurance.status).toBe(HttpStatus.CREATED);
    expect(new Date(insurance.body.policyExpiresAt).toISOString()).toBe(
      FUTURE_INSURANCE_EXPIRY.toISOString(),
    );

    const submitted = await request(app.getHttpServer())
      .post(`/api/fleet-owner/cars/${carId}/submissions`)
      .set("Cookie", ownerCookie);
    expect(submitted.status).toBe(HttpStatus.CREATED);

    const reviewList = await request(app.getHttpServer())
      .get("/api/admin/cars?approvalStatus=PENDING&page=1&limit=50")
      .set("Cookie", adminCookie);
    expect(reviewList.status).toBe(HttpStatus.OK);
    expect(reviewList.body.cars.map((car: { id: string }) => car.id)).toContain(carId);

    const review = await request(app.getHttpServer())
      .get(`/api/admin/cars/${carId}`)
      .set("Cookie", adminCookie);
    expect(review.status).toBe(HttpStatus.OK);
    const documentIds = (review.body.documents as { id: string }[]).map((document) => document.id);
    const imageId = (review.body.images as { id: string }[])[0]?.id;
    expect(documentIds).toHaveLength(2);
    expect(imageId).toBeDefined();
    expect(assets.images.body.images?.length ?? 1).toBeGreaterThan(0);

    for (const documentId of documentIds) {
      const approvedDocument = await request(app.getHttpServer())
        .post(`/api/admin/documents/${documentId}/approve`)
        .set("Cookie", adminCookie);
      expect(approvedDocument.status).toBe(HttpStatus.CREATED);
    }

    const approvedImage = await request(app.getHttpServer())
      .post(`/api/admin/cars/${carId}/images/${imageId}/approve`)
      .set("Cookie", adminCookie);
    expect(approvedImage.status).toBe(HttpStatus.CREATED);

    const published = await factory.getCarById(carId);
    expect(published?.approvalStatus).toBe("APPROVED");
    expect(published?.status).toBe("AVAILABLE");

    const publicCar = await request(app.getHttpServer()).get(`/api/cars/${carId}`);
    expect(publicCar.status).toBe(HttpStatus.OK);
    expect(publicCar.body.id).toBe(carId);
  });

  it("blocks admin approval when a verified car's insurance has expired", async () => {
    const { plateNumber, chassisNumber, carId } = await createVerifiedDraftCar();
    await uploadDraftAssets(carId);
    mockSuccessfulInsurance(plateNumber, chassisNumber);

    const insurance = await withOwner(
      request(app.getHttpServer()).post(`/api/fleet-owner/cars/${carId}/insurance-verifications`),
    )
      .set("Idempotency-Key", randomUUID())
      .send({ policyNumber: "POL-THEN-EXPIRE" });
    expect(insurance.status).toBe(HttpStatus.CREATED);

    const submitted = await request(app.getHttpServer())
      .post(`/api/fleet-owner/cars/${carId}/submissions`)
      .set("Cookie", ownerCookie);
    expect(submitted.status).toBe(HttpStatus.CREATED);

    const review = await request(app.getHttpServer())
      .get(`/api/admin/cars/${carId}`)
      .set("Cookie", adminCookie);
    const documentIds = (review.body.documents as { id: string }[]).map((document) => document.id);
    const imageId = (review.body.images as { id: string }[])[0]?.id;

    for (const documentId of documentIds) {
      await request(app.getHttpServer())
        .post(`/api/admin/documents/${documentId}/approve`)
        .set("Cookie", adminCookie);
    }

    await databaseService.insuranceVerification.update({
      where: { id: insurance.body.id },
      data: { policyExpiresAt: new Date(Date.now() - 60_000) },
    });

    const blockedImage = await request(app.getHttpServer())
      .post(`/api/admin/cars/${carId}/images/${imageId}/approve`)
      .set("Cookie", adminCookie);
    expect(blockedImage.status).toBe(HttpStatus.CREATED);
    expect((await factory.getCarById(carId))?.approvalStatus).toBe("PENDING");

    const blockedApprove = await request(app.getHttpServer())
      .post(`/api/admin/cars/${carId}/approve`)
      .set("Cookie", adminCookie);
    expect(blockedApprove.status).toBe(HttpStatus.CONFLICT);

    await databaseService.insuranceVerification.update({
      where: { id: insurance.body.id },
      data: { policyExpiresAt: FUTURE_INSURANCE_EXPIRY },
    });

    const published = await request(app.getHttpServer())
      .post(`/api/admin/cars/${carId}/approve`)
      .set("Cookie", adminCookie);
    expect(published.status).toBe(HttpStatus.CREATED);
    expect((await factory.getCarById(carId))?.approvalStatus).toBe("APPROVED");
  });
});
