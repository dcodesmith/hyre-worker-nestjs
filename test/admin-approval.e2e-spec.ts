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

describe("Admin Approval E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let adminCookie: string;
  let staffCookie: string;
  let ownerCookie: string;
  let ownerId: string;
  let otherOwnerCookie: string;

  const pdfBuffer = Buffer.from("%PDF-1.4 replacement");
  const imageBuffer = Buffer.from("fake-image-bytes");
  const deleteObjectByKey = vi.fn().mockResolvedValue(undefined);

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
        deleteObjectByKey,
      })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);
    await app.init();

    const adminAuth = await factory.createAuthenticatedAdmin(uniqueEmail("approval-admin"));
    adminCookie = adminAuth.cookie;

    const staffAuth = await factory.authenticateAndGetUser(uniqueEmail("approval-staff"), "user");
    await factory.assignRole(staffAuth.user.id, "staff");
    staffCookie = staffAuth.cookie;

    const ownerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("approval-owner"),
      "fleetOwner",
      "web",
    );
    ownerCookie = ownerAuth.cookie;
    ownerId = ownerAuth.user.id;

    const otherOwnerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("approval-owner-2"),
      "fleetOwner",
      "web",
    );
    otherOwnerCookie = otherOwnerAuth.cookie;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Create a PENDING car with one pending image and one pending MOT document. */
  async function createCarUnderReview() {
    const car = await factory.createCar(ownerId, { approvalStatus: "PENDING" });
    const image = await databaseService.vehicleImage.create({
      data: {
        carId: car.id,
        url: `https://cdn.tripdly.test/${ownerId}/${car.id}/images/photo.jpg`,
        status: "PENDING",
      },
    });
    const document = await databaseService.documentApproval.create({
      data: {
        carId: car.id,
        documentType: "MOT_CERTIFICATE",
        documentUrl: `https://cdn.tripdly.test/${ownerId}/${car.id}/documents/mot.pdf`,
        status: "PENDING",
      },
    });
    return { car, image, document };
  }

  describe("role enforcement", () => {
    it("blocks fleet owners from admin car endpoints", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/admin/cars")
        .set("Cookie", ownerCookie);

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("blocks fleet owners from approving documents", async () => {
      const { document } = await createCarUnderReview();

      const response = await request(app.getHttpServer())
        .post(`/api/admin/documents/${document.id}/approve`)
        .set("Cookie", ownerCookie);

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("blocks unauthenticated requests", async () => {
      const response = await request(app.getHttpServer()).get("/api/admin/cars");

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe("admin review reads", () => {
    it("lists cars filtered by approval status with pagination meta", async () => {
      const { car } = await createCarUnderReview();

      const response = await request(app.getHttpServer())
        .get("/api/admin/cars?approvalStatus=PENDING&page=1&limit=50")
        .set("Cookie", adminCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.meta).toMatchObject({ page: 1, limit: 50 });
      const ids = response.body.cars.map((c: { id: string }) => c.id);
      expect(ids).toContain(car.id);
    });

    it("returns car detail with documents and images for staff", async () => {
      const { car, image, document } = await createCarUnderReview();

      const response = await request(app.getHttpServer())
        .get(`/api/admin/cars/${car.id}`)
        .set("Cookie", staffCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.id).toBe(car.id);
      expect(response.body.images.map((i: { id: string }) => i.id)).toContain(image.id);
      expect(response.body.documents.map((d: { id: string }) => d.id)).toContain(document.id);
      expect(response.body.owner.id).toBe(ownerId);
    });

    it("returns 404 for an unknown car", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/admin/cars/cunknowncarid0000000000000")
        .set("Cookie", adminCookie);

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe("approval cascade", () => {
    it("approves the car once staff and admin approve all pending items", async () => {
      const { car, image, document } = await createCarUnderReview();

      const documentResponse = await request(app.getHttpServer())
        .post(`/api/admin/documents/${document.id}/approve`)
        .set("Cookie", staffCookie);
      expect(documentResponse.status).toBe(HttpStatus.CREATED);

      let carRow = await factory.getCarById(car.id);
      expect(carRow?.approvalStatus).toBe("PENDING");

      const imageResponse = await request(app.getHttpServer())
        .post(`/api/admin/cars/${car.id}/images/${image.id}/approve`)
        .set("Cookie", adminCookie);
      expect(imageResponse.status).toBe(HttpStatus.CREATED);

      carRow = await factory.getCarById(car.id);
      expect(carRow?.approvalStatus).toBe("APPROVED");
      expect(carRow?.approvalNotes).toBeNull();
    });

    it("rejecting a document requires notes and flags the car for action", async () => {
      const { car, document } = await createCarUnderReview();

      const missingNotes = await request(app.getHttpServer())
        .post(`/api/admin/documents/${document.id}/reject`)
        .set("Cookie", adminCookie)
        .send({});
      expect(missingNotes.status).toBe(HttpStatus.BAD_REQUEST);

      const response = await request(app.getHttpServer())
        .post(`/api/admin/documents/${document.id}/reject`)
        .set("Cookie", adminCookie)
        .send({ notes: "Certificate expired" });
      expect(response.status).toBe(HttpStatus.CREATED);

      const carRow = await factory.getCarById(car.id);
      expect(carRow?.approvalStatus).toBe("PENDING");
      expect(carRow?.approvalNotes).toContain("Action required");

      const documentRow = await databaseService.documentApproval.findUnique({
        where: { id: document.id },
      });
      expect(documentRow?.status).toBe("REJECTED");
      expect(documentRow?.notes).toBe("Certificate expired");
    });

    it("keeps the car PENDING when a rejected item remains after approving the rest", async () => {
      const { car, image, document } = await createCarUnderReview();
      await databaseService.vehicleImage.update({
        where: { id: image.id },
        data: { status: "REJECTED", notes: "Too blurry" },
      });

      const documentResponse = await request(app.getHttpServer())
        .post(`/api/admin/documents/${document.id}/approve`)
        .set("Cookie", adminCookie);
      expect(documentResponse.status).toBe(HttpStatus.CREATED);

      const carRow = await factory.getCarById(car.id);
      expect(carRow?.approvalStatus).toBe("PENDING");
    });

    it("sets the cover image and unsets the previous one", async () => {
      const { car, image } = await createCarUnderReview();
      await databaseService.vehicleImage.update({
        where: { id: image.id },
        data: { status: "APPROVED" },
      });
      const secondImage = await databaseService.vehicleImage.create({
        data: {
          carId: car.id,
          url: "https://cdn.tripdly.test/second.jpg",
          status: "APPROVED",
          isPrimary: true,
        },
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/admin/cars/${car.id}/cover`)
        .set("Cookie", adminCookie)
        .send({ imageId: image.id });
      expect(response.status).toBe(HttpStatus.OK);

      const [first, second] = await Promise.all([
        databaseService.vehicleImage.findUnique({ where: { id: image.id } }),
        databaseService.vehicleImage.findUnique({ where: { id: secondImage.id } }),
      ]);
      expect(first?.isPrimary).toBe(true);
      expect(second?.isPrimary).toBe(false);
    });

    it("rejects setting a non-approved image as the cover", async () => {
      const { car, image } = await createCarUnderReview();

      const response = await request(app.getHttpServer())
        .patch(`/api/admin/cars/${car.id}/cover`)
        .set("Cookie", adminCookie)
        .send({ imageId: image.id });

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe("owner re-upload of rejected files", () => {
    it("lets the owner replace a rejected document, then approval completes the loop", async () => {
      const { car, image, document } = await createCarUnderReview();
      await databaseService.documentApproval.update({
        where: { id: document.id },
        data: { status: "REJECTED", notes: "Blurry scan" },
      });

      deleteObjectByKey.mockClear();
      const replaceResponse = await request(app.getHttpServer())
        .put(`/api/fleet-owner/cars/${car.id}/documents/${document.id}/file`)
        .set("Cookie", ownerCookie)
        .attach("file", pdfBuffer, { filename: "mot-v2.pdf", contentType: "application/pdf" });
      expect(replaceResponse.status).toBe(HttpStatus.OK);

      const documentRow = await databaseService.documentApproval.findUnique({
        where: { id: document.id },
      });
      expect(documentRow?.status).toBe("PENDING");
      expect(documentRow?.notes).toBeNull();
      expect(documentRow?.documentUrl).toContain("mot-v2");
      // Re-upload demotes the car so it cannot stay publicly searchable
      const pendingCar = await factory.getCarById(car.id);
      expect(pendingCar?.approvalStatus).toBe("PENDING");
      // The previous stored file is cleaned up
      expect(deleteObjectByKey).toHaveBeenCalledWith(`${ownerId}/${car.id}/documents/mot.pdf`);

      // Approve everything and confirm the car completes review
      await request(app.getHttpServer())
        .post(`/api/admin/documents/${document.id}/approve`)
        .set("Cookie", adminCookie);
      await request(app.getHttpServer())
        .post(`/api/admin/cars/${car.id}/images/${image.id}/approve`)
        .set("Cookie", adminCookie);

      const carRow = await factory.getCarById(car.id);
      expect(carRow?.approvalStatus).toBe("APPROVED");
    });

    it("lets the owner replace a rejected image", async () => {
      const { car, image } = await createCarUnderReview();
      await databaseService.vehicleImage.update({
        where: { id: image.id },
        data: { status: "REJECTED", notes: "Too dark" },
      });

      deleteObjectByKey.mockClear();
      const response = await request(app.getHttpServer())
        .put(`/api/fleet-owner/cars/${car.id}/images/${image.id}/file`)
        .set("Cookie", ownerCookie)
        .attach("file", imageBuffer, { filename: "photo-v2.jpg", contentType: "image/jpeg" });
      expect(response.status).toBe(HttpStatus.OK);

      const imageRow = await databaseService.vehicleImage.findUnique({ where: { id: image.id } });
      expect(imageRow?.status).toBe("PENDING");
      expect(imageRow?.notes).toBeNull();
      expect(imageRow?.url).toContain("photo-v2");
      // The previous stored file is cleaned up
      expect(deleteObjectByKey).toHaveBeenCalledWith(`${ownerId}/${car.id}/images/photo.jpg`);
    });

    it("pulls an APPROVED car back to PENDING when a rejected file is re-uploaded", async () => {
      const { car, image } = await createCarUnderReview();
      await databaseService.vehicleImage.update({
        where: { id: image.id },
        data: { status: "REJECTED", notes: "Too dark" },
      });
      // Force-approve can leave the listing public while rejected assets remain
      await request(app.getHttpServer())
        .post(`/api/admin/cars/${car.id}/approve`)
        .set("Cookie", adminCookie)
        .expect(HttpStatus.CREATED);

      await request(app.getHttpServer())
        .put(`/api/fleet-owner/cars/${car.id}/images/${image.id}/file`)
        .set("Cookie", ownerCookie)
        .attach("file", imageBuffer, { filename: "photo-v2.jpg", contentType: "image/jpeg" })
        .expect(HttpStatus.OK);

      const carRow = await factory.getCarById(car.id);
      expect(carRow?.approvalStatus).toBe("PENDING");
    });

    it("rejects replacing a document that has not been rejected", async () => {
      const { car, document } = await createCarUnderReview();

      const response = await request(app.getHttpServer())
        .put(`/api/fleet-owner/cars/${car.id}/documents/${document.id}/file`)
        .set("Cookie", ownerCookie)
        .attach("file", pdfBuffer, { filename: "mot-v2.pdf", contentType: "application/pdf" });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("rejects a non-PDF replacement for a document", async () => {
      const { car, document } = await createCarUnderReview();
      await databaseService.documentApproval.update({
        where: { id: document.id },
        data: { status: "REJECTED" },
      });

      const response = await request(app.getHttpServer())
        .put(`/api/fleet-owner/cars/${car.id}/documents/${document.id}/file`)
        .set("Cookie", ownerCookie)
        .attach("file", imageBuffer, { filename: "mot.jpg", contentType: "image/jpeg" });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("blocks another fleet owner from replacing files on a car they do not own", async () => {
      const { car, document } = await createCarUnderReview();
      await databaseService.documentApproval.update({
        where: { id: document.id },
        data: { status: "REJECTED" },
      });

      const response = await request(app.getHttpServer())
        .put(`/api/fleet-owner/cars/${car.id}/documents/${document.id}/file`)
        .set("Cookie", otherOwnerCookie)
        .attach("file", pdfBuffer, { filename: "mot-v2.pdf", contentType: "application/pdf" });

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });
  });
});
