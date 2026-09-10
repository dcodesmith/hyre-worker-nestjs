import { createHash } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  CarApprovalStatus,
  DocumentStatus,
  Prisma,
  ProviderVerificationStatus,
  ServiceTier,
  Status,
  VehicleType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { PromotionService } from "../promotion/promotion.service";
import { StorageService } from "../storage/storage.service";
import { REJECTION_ACTION_NOTE } from "./car.const";
import {
  CarAssetsAlreadyUploadedException,
  CarCreateFailedException,
  CarDocumentNotFoundException,
  CarFetchFailedException,
  CarNotFoundException,
  CarStatusUpdateNotAllowedException,
  CarSubmissionRequirementsNotMetException,
  CarUpdateFailedException,
  ChassisNumberAlreadyExistsException,
  FileNotRejectedException,
  RegistrationNumberAlreadyExistsException,
  VehicleImageNotFoundException,
} from "./car.error";
import { CarService } from "./car.service";
import { CarPromotionEnrichmentService } from "./car-promotion.enrichment";

const recordNotFoundError = () =>
  new Prisma.PrismaClientKnownRequestError("Record not found", {
    code: "P2025",
    clientVersion: "test",
  });

describe("CarService", () => {
  let service: CarService;
  const createMockFile = (name: string, mimetype: string, content = "file") => ({
    fieldname: "file",
    originalname: name,
    encoding: "7bit",
    mimetype,
    buffer: Buffer.from(content),
    size: Buffer.byteLength(content),
  });
  const databaseServiceMock = {
    car: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    vehicleImage: {
      createMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    documentApproval: {
      createMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    vehicleVerification: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    insuranceVerification: {
      count: vi.fn(),
      create: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  const storageServiceMock = {
    uploadBuffer: vi.fn(),
    deleteObjectByKey: vi.fn(),
  };
  const promotionServiceMock = {
    getActivePromotionsForCars: vi.fn(),
    getActivePromotionForCar: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    databaseServiceMock.$transaction.mockImplementation((cb) => cb(databaseServiceMock));
    databaseServiceMock.documentApproval.count.mockResolvedValue(0);
    databaseServiceMock.vehicleImage.count.mockResolvedValue(0);
    databaseServiceMock.$queryRaw.mockResolvedValue([{ id: "car-1" }]);
    storageServiceMock.deleteObjectByKey.mockResolvedValue(undefined);
    promotionServiceMock.getActivePromotionsForCars.mockResolvedValue(new Map());
    promotionServiceMock.getActivePromotionForCar.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CarService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: StorageService, useValue: storageServiceMock },
        { provide: PromotionService, useValue: promotionServiceMock },
        CarPromotionEnrichmentService,
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<CarService>(CarService);
  });

  it("lists owner cars ordered by latest updates", async () => {
    databaseServiceMock.car.findMany.mockResolvedValueOnce([
      { id: "car-1", ownerId: "owner-1" },
      { id: "car-2", ownerId: "owner-1" },
    ]);

    const result = await service.listOwnerCars("owner-1");

    expect(result).toEqual([
      { id: "car-1", ownerId: "owner-1", promotion: null },
      { id: "car-2", ownerId: "owner-1", promotion: null },
    ]);
    expect(databaseServiceMock.car.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: "owner-1" }, orderBy: { updatedAt: "desc" } }),
    );
  });

  it("returns owner car detail", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1", ownerId: "owner-1" });

    const result = await service.getOwnerCarById("car-1", "owner-1");

    expect(result).toEqual({ id: "car-1", ownerId: "owner-1", promotion: null });
  });

  it("requests the latest insurance verification fields for owner car list and detail", async () => {
    const submittedAt = new Date("2026-09-07T00:00:00.000Z");
    const ownerCar = { id: "car-1", ownerId: "owner-1", submittedAt };
    const latestInsuranceVerification = {
      select: {
        id: true,
        status: true,
        policyNumber: true,
        policyStatus: true,
        policyExpiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 1,
    };

    databaseServiceMock.car.findMany.mockResolvedValueOnce([ownerCar]);
    databaseServiceMock.car.findFirst.mockResolvedValueOnce(ownerCar);

    const [list, detail] = await Promise.all([
      service.listOwnerCars("owner-1"),
      service.getOwnerCarById("car-1", "owner-1"),
    ]);

    expect(list).toEqual([{ ...ownerCar, promotion: null }]);
    expect(detail).toEqual({ ...ownerCar, promotion: null });
    expect(databaseServiceMock.car.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ insuranceVerifications: latestInsuranceVerification }),
      }),
    );
    expect(databaseServiceMock.car.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ insuranceVerifications: latestInsuranceVerification }),
      }),
    );
  });

  it("throws CarNotFoundException for unknown owner car", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce(null);

    await expect(service.getOwnerCarById("missing", "owner-1")).rejects.toBeInstanceOf(
      CarNotFoundException,
    );
  });

  it("updates owner car", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce({
      id: "car-1",
      registrationNumber: "ABC-123XY",
      status: Status.HOLD,
    });
    databaseServiceMock.car.update.mockResolvedValueOnce({
      id: "car-1",
      ownerId: "owner-1",
      status: Status.HOLD,
    });

    const result = await service.updateCar("car-1", "owner-1", { status: Status.HOLD });

    expect(result).toEqual({
      id: "car-1",
      ownerId: "owner-1",
      status: Status.HOLD,
      promotion: null,
    });
    expect(databaseServiceMock.car.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "car-1", status: { not: Status.BOOKED } },
      }),
    );
  });

  it("rejects manual status changes for a booked car", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce({
      id: "car-1",
      registrationNumber: "ABC-123XY",
      status: Status.BOOKED,
    });

    await expect(
      service.updateCar("car-1", "owner-1", { status: Status.AVAILABLE }),
    ).rejects.toBeInstanceOf(CarStatusUpdateNotAllowedException);
    expect(databaseServiceMock.car.update).not.toHaveBeenCalled();
  });

  it("rejects a status update when the car becomes booked before the write", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce({
      id: "car-1",
      registrationNumber: "ABC-123XY",
      status: Status.AVAILABLE,
    });
    databaseServiceMock.car.update.mockRejectedValueOnce(recordNotFoundError());

    await expect(
      service.updateCar("car-1", "owner-1", { status: Status.HOLD }),
    ).rejects.toBeInstanceOf(CarStatusUpdateNotAllowedException);
  });

  it("allows rate changes for a booked car", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce({
      id: "car-1",
      registrationNumber: "ABC-123XY",
      status: Status.BOOKED,
    });
    databaseServiceMock.car.update.mockResolvedValueOnce({
      id: "car-1",
      ownerId: "owner-1",
      status: Status.BOOKED,
      dayRate: 55_000,
    });

    await expect(service.updateCar("car-1", "owner-1", { dayRate: 55_000 })).resolves.toEqual({
      id: "car-1",
      ownerId: "owner-1",
      status: Status.BOOKED,
      dayRate: 55_000,
      promotion: null,
    });
    expect(databaseServiceMock.car.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "car-1" } }),
    );
  });

  it("rejects update when registration number conflicts after normalization", async () => {
    databaseServiceMock.car.findFirst
      .mockResolvedValueOnce({
        id: "car-1",
        registrationNumber: "ZZZ-999AA",
        status: Status.AVAILABLE,
      })
      .mockResolvedValueOnce({ id: "other-car" });

    await expect(
      service.updateCar("car-1", "owner-1", { registrationNumber: "ABC 123XY" }),
    ).rejects.toBeInstanceOf(RegistrationNumberAlreadyExistsException);
  });

  it("throws CarFetchFailedException when list query fails unexpectedly", async () => {
    databaseServiceMock.car.findMany.mockRejectedValueOnce(new Error("db down"));

    await expect(service.listOwnerCars("owner-1")).rejects.toBeInstanceOf(CarFetchFailedException);
  });

  it("returns owner cars when promotion enrichment fails", async () => {
    databaseServiceMock.car.findMany.mockResolvedValueOnce([{ id: "car-1", ownerId: "owner-1" }]);
    promotionServiceMock.getActivePromotionsForCars.mockRejectedValueOnce(
      new Error("promotion down"),
    );

    const result = await service.listOwnerCars("owner-1");

    expect(result).toEqual([{ id: "car-1", ownerId: "owner-1", promotion: null }]);
  });

  it("enriches owner car list with active promotion when present", async () => {
    databaseServiceMock.car.findMany.mockResolvedValueOnce([{ id: "car-1", ownerId: "owner-1" }]);
    promotionServiceMock.getActivePromotionsForCars.mockResolvedValueOnce(
      new Map([
        [
          "car-1",
          {
            id: "promo-1",
            name: "Weekend Deal",
            discountValue: 15,
          },
        ],
      ]),
    );

    const result = await service.listOwnerCars("owner-1");

    expect(result).toEqual([
      {
        id: "car-1",
        ownerId: "owner-1",
        promotion: {
          id: "promo-1",
          name: "Weekend Deal",
          discountValue: 15,
        },
      },
    ]);
  });

  it("returns owner car detail when promotion enrichment fails", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1", ownerId: "owner-1" });
    promotionServiceMock.getActivePromotionForCar.mockRejectedValueOnce(
      new Error("promotion down"),
    );

    const result = await service.getOwnerCarById("car-1", "owner-1");

    expect(result).toEqual({ id: "car-1", ownerId: "owner-1", promotion: null });
  });

  it("returns updated car when promotion enrichment fails", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce({
      id: "car-1",
      registrationNumber: "ABC-123XY",
    });
    databaseServiceMock.car.update.mockResolvedValueOnce({
      id: "car-1",
      ownerId: "owner-1",
      status: Status.HOLD,
    });
    promotionServiceMock.getActivePromotionForCar.mockRejectedValueOnce(
      new Error("promotion down"),
    );

    const result = await service.updateCar("car-1", "owner-1", { status: Status.HOLD });

    expect(result).toEqual({
      id: "car-1",
      ownerId: "owner-1",
      status: Status.HOLD,
      promotion: null,
    });
  });

  describe("replaceCarImage", () => {
    const rejectedImage = {
      id: "img-1",
      status: DocumentStatus.REJECTED,
      url: "https://bucket.s3.eu-west-1.amazonaws.com/owner-1/car-1/images/old.jpg",
    };

    it("replaces a rejected image and resets it to PENDING", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.vehicleImage.findFirst.mockResolvedValueOnce(rejectedImage);
      storageServiceMock.uploadBuffer.mockResolvedValueOnce("https://cdn.test/new.jpg");
      databaseServiceMock.vehicleImage.update.mockResolvedValueOnce({
        id: "img-1",
        url: "https://cdn.test/new.jpg",
        status: DocumentStatus.PENDING,
      });

      const result = await service.replaceCarImage(
        "car-1",
        "owner-1",
        "img-1",
        createMockFile("new.jpg", "image/jpeg"),
      );

      expect(result.success).toBe(true);
      expect(databaseServiceMock.vehicleImage.update).toHaveBeenCalledWith({
        where: { id: "img-1", status: DocumentStatus.REJECTED },
        data: {
          url: "https://cdn.test/new.jpg",
          status: DocumentStatus.PENDING,
          notes: null,
          approvedById: null,
          approvedAt: null,
        },
      });
      expect(databaseServiceMock.car.update).toHaveBeenCalledWith({
        where: { id: "car-1" },
        data: {
          approvalStatus: CarApprovalStatus.PENDING,
          approvalNotes: REJECTION_ACTION_NOTE,
        },
      });
      expect(storageServiceMock.deleteObjectByKey).toHaveBeenCalledWith(
        "owner-1/car-1/images/old.jpg",
      );
    });

    it("throws CarNotFoundException when the car is not owned by the caller", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.replaceCarImage(
          "car-1",
          "intruder",
          "img-1",
          createMockFile("new.jpg", "image/jpeg"),
        ),
      ).rejects.toBeInstanceOf(CarNotFoundException);
      expect(storageServiceMock.uploadBuffer).not.toHaveBeenCalled();
    });

    it("throws VehicleImageNotFoundException when the image does not belong to the car", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.vehicleImage.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.replaceCarImage("car-1", "owner-1", "stale", createMockFile("a.jpg", "image/jpeg")),
      ).rejects.toBeInstanceOf(VehicleImageNotFoundException);
    });

    it("rejects replacing an image that is not REJECTED", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.vehicleImage.findFirst.mockResolvedValueOnce({
        ...rejectedImage,
        status: DocumentStatus.PENDING,
      });

      await expect(
        service.replaceCarImage("car-1", "owner-1", "img-1", createMockFile("a.jpg", "image/jpeg")),
      ).rejects.toBeInstanceOf(FileNotRejectedException);
      expect(storageServiceMock.uploadBuffer).not.toHaveBeenCalled();
    });

    it("does not fail the replacement when old S3 object cleanup fails", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.vehicleImage.findFirst.mockResolvedValueOnce(rejectedImage);
      storageServiceMock.uploadBuffer.mockResolvedValueOnce("https://cdn.test/new.jpg");
      databaseServiceMock.vehicleImage.update.mockResolvedValueOnce({ id: "img-1" });
      storageServiceMock.deleteObjectByKey.mockRejectedValueOnce(new Error("s3 down"));

      const result = await service.replaceCarImage(
        "car-1",
        "owner-1",
        "img-1",
        createMockFile("new.jpg", "image/jpeg"),
      );

      expect(result.success).toBe(true);
    });

    it("deletes the newly uploaded object when the DB update fails", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.vehicleImage.findFirst.mockResolvedValueOnce(rejectedImage);
      storageServiceMock.uploadBuffer.mockResolvedValueOnce("https://cdn.test/new.jpg");
      databaseServiceMock.vehicleImage.update.mockRejectedValueOnce(new Error("db down"));

      await expect(
        service.replaceCarImage("car-1", "owner-1", "img-1", createMockFile("a.jpg", "image/jpeg")),
      ).rejects.toBeInstanceOf(CarUpdateFailedException);

      expect(storageServiceMock.deleteObjectByKey).toHaveBeenCalledWith(
        expect.stringContaining("owner-1/car-1/images/"),
      );
    });

    it("throws FileNotRejectedException when the status changes between check and write", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.vehicleImage.findFirst.mockResolvedValueOnce(rejectedImage);
      storageServiceMock.uploadBuffer.mockResolvedValueOnce("https://cdn.test/new.jpg");
      // Prisma throws P2025 when the guarded update matches no record
      databaseServiceMock.vehicleImage.update.mockRejectedValueOnce(recordNotFoundError());

      await expect(
        service.replaceCarImage("car-1", "owner-1", "img-1", createMockFile("a.jpg", "image/jpeg")),
      ).rejects.toBeInstanceOf(FileNotRejectedException);

      expect(storageServiceMock.deleteObjectByKey).toHaveBeenCalledWith(
        expect.stringContaining("owner-1/car-1/images/"),
      );
    });
  });

  describe("replaceCarDocument", () => {
    const rejectedDocument = {
      id: "doc-1",
      status: DocumentStatus.REJECTED,
      documentUrl: "https://bucket.s3.eu-west-1.amazonaws.com/owner-1/car-1/documents/old.pdf",
    };

    it("replaces a rejected document and resets it to PENDING", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.documentApproval.findFirst.mockResolvedValueOnce(rejectedDocument);
      storageServiceMock.uploadBuffer.mockResolvedValueOnce("owner-1/car-1/documents/new.pdf");
      databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
        id: "doc-1",
        documentUrl: "owner-1/car-1/documents/new.pdf",
        status: DocumentStatus.PENDING,
      });

      const result = await service.replaceCarDocument(
        "car-1",
        "owner-1",
        "doc-1",
        createMockFile("new.pdf", "application/pdf"),
      );

      expect(result.success).toBe(true);
      expect(databaseServiceMock.documentApproval.update).toHaveBeenCalledWith({
        where: { id: "doc-1", status: DocumentStatus.REJECTED },
        data: {
          documentUrl: "owner-1/car-1/documents/new.pdf",
          status: DocumentStatus.PENDING,
          notes: null,
          approvedById: null,
          approvedAt: null,
        },
      });
      expect(databaseServiceMock.car.update).toHaveBeenCalledWith({
        where: { id: "car-1" },
        data: {
          approvalStatus: CarApprovalStatus.PENDING,
          approvalNotes: REJECTION_ACTION_NOTE,
        },
      });
      expect(storageServiceMock.deleteObjectByKey).toHaveBeenCalledWith(
        "owner-1/car-1/documents/old.pdf",
      );
    });

    it("throws CarDocumentNotFoundException when the document does not belong to the car", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.documentApproval.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.replaceCarDocument(
          "car-1",
          "owner-1",
          "stale",
          createMockFile("a.pdf", "application/pdf"),
        ),
      ).rejects.toBeInstanceOf(CarDocumentNotFoundException);
    });

    it("rejects replacing a document that is not REJECTED", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.documentApproval.findFirst.mockResolvedValueOnce({
        ...rejectedDocument,
        status: DocumentStatus.APPROVED,
      });

      await expect(
        service.replaceCarDocument(
          "car-1",
          "owner-1",
          "doc-1",
          createMockFile("a.pdf", "application/pdf"),
        ),
      ).rejects.toBeInstanceOf(FileNotRejectedException);
      expect(storageServiceMock.uploadBuffer).not.toHaveBeenCalled();
    });

    it("deletes the newly uploaded object when the DB update fails", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.documentApproval.findFirst.mockResolvedValueOnce(rejectedDocument);
      storageServiceMock.uploadBuffer.mockResolvedValueOnce("https://cdn.test/new.pdf");
      databaseServiceMock.documentApproval.update.mockRejectedValueOnce(new Error("db down"));

      await expect(
        service.replaceCarDocument(
          "car-1",
          "owner-1",
          "doc-1",
          createMockFile("a.pdf", "application/pdf"),
        ),
      ).rejects.toBeInstanceOf(CarUpdateFailedException);

      expect(storageServiceMock.deleteObjectByKey).toHaveBeenCalledWith(
        expect.stringContaining("owner-1/car-1/documents/"),
      );
    });

    it("deletes a replaced document stored as an object key", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.documentApproval.findFirst.mockResolvedValueOnce({
        ...rejectedDocument,
        documentUrl: "owner-1/car-1/documents/old.pdf",
      });
      storageServiceMock.uploadBuffer.mockResolvedValueOnce("owner-1/car-1/documents/new.pdf");
      databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
        id: "doc-1",
        documentUrl: "owner-1/car-1/documents/new.pdf",
        status: DocumentStatus.PENDING,
      });

      await service.replaceCarDocument(
        "car-1",
        "owner-1",
        "doc-1",
        createMockFile("new.pdf", "application/pdf"),
      );

      expect(storageServiceMock.deleteObjectByKey).toHaveBeenCalledWith(
        "owner-1/car-1/documents/old.pdf",
      );
    });
  });

  describe("createDraftCarFromVerification", () => {
    const verification = {
      id: "ver-1",
      ownerId: "owner-1",
      plateNumber: "KJA-123 AB",
      chassisNumber: "1HGCM82633A004352",
      make: "Toyota",
      model: "Camry",
      year: 2020,
      color: "Black",
      passengerCapacity: 5,
    };

    it("creates a draft car, persists a normalized plate, and consumes the verification once", async () => {
      databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: false });
      databaseServiceMock.vehicleVerification.findFirst.mockResolvedValueOnce(verification);
      databaseServiceMock.car.create.mockResolvedValueOnce({
        id: "car-1",
        ownerId: "owner-1",
        registrationNumber: "KJA123AB",
        chassisNumber: verification.chassisNumber,
        dayRate: null,
        hourlyRate: null,
      });
      databaseServiceMock.vehicleVerification.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.createDraftCarFromVerification("owner-1", "ver-1");

      expect(result).toMatchObject({
        id: "car-1",
        registrationNumber: "KJA123AB",
        chassisNumber: verification.chassisNumber,
        dayRate: null,
        hourlyRate: null,
      });
      expect(databaseServiceMock.car.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ownerId: "owner-1",
            registrationNumber: "KJA123AB",
            chassisNumber: verification.chassisNumber,
            make: "Toyota",
            model: "Camry",
            year: 2020,
            color: "Black",
            status: Status.HOLD,
            approvalStatus: CarApprovalStatus.PENDING,
          }),
        }),
      );
      expect(databaseServiceMock.vehicleVerification.updateMany).toHaveBeenCalledWith({
        where: { id: "ver-1", carId: null },
        data: { carId: "car-1" },
      });
      expect(databaseServiceMock.insuranceVerification.create).not.toHaveBeenCalled();
    });

    it("creates a SUCCEEDED InsuranceVerification in the same transaction when an unexpired snapshot exists", async () => {
      const policyExpiresAt = new Date("2027-01-14T22:59:59.999Z");
      databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: false });
      databaseServiceMock.vehicleVerification.findFirst.mockResolvedValueOnce({
        ...verification,
        insurancePolicyNumber: "TEST/POLICY/123",
        insurancePolicyStatus: "Active",
        insurancePolicyExpiresAt: policyExpiresAt,
        insuranceProviderRef: "ins-ref",
      });
      databaseServiceMock.car.create.mockResolvedValueOnce({
        id: "car-1",
        ownerId: "owner-1",
        registrationNumber: "KJA123AB",
        chassisNumber: verification.chassisNumber,
      });
      databaseServiceMock.vehicleVerification.updateMany.mockResolvedValueOnce({ count: 1 });
      databaseServiceMock.insuranceVerification.create.mockResolvedValueOnce({ id: "ins-1" });

      const result = await service.createDraftCarFromVerification("owner-1", "ver-1");

      expect(result).toMatchObject({ id: "car-1" });
      expect(databaseServiceMock.$transaction).toHaveBeenCalledTimes(1);
      expect(databaseServiceMock.insuranceVerification.create).toHaveBeenCalledWith({
        data: {
          ownerId: "owner-1",
          carId: "car-1",
          idempotencyKey: "initial-insurance:ver-1",
          requestHash: createHash("sha256")
            .update(JSON.stringify({ carId: "car-1", policyNumber: "TEST/POLICY/123" }))
            .digest("hex"),
          policyNumber: "TEST/POLICY/123",
          policyStatus: "Active",
          policyExpiresAt,
          providerRef: "ins-ref",
          status: ProviderVerificationStatus.SUCCEEDED,
        },
      });
    });

    it("uses a deterministic initial-insurance idempotency key and request hash across calls", async () => {
      const snapshot = {
        ...verification,
        insurancePolicyNumber: "TEST/POLICY/123",
        insurancePolicyStatus: "Active",
        insurancePolicyExpiresAt: new Date("2027-01-14T22:59:59.999Z"),
        insuranceProviderRef: "ins-ref",
      };
      databaseServiceMock.user.findUnique.mockResolvedValue({ isOwnerDriver: false });
      databaseServiceMock.vehicleVerification.findFirst.mockResolvedValue(snapshot);
      databaseServiceMock.car.create.mockResolvedValue({
        id: "car-1",
        ownerId: "owner-1",
        registrationNumber: "KJA123AB",
        chassisNumber: verification.chassisNumber,
      });
      databaseServiceMock.vehicleVerification.updateMany.mockResolvedValue({ count: 1 });
      databaseServiceMock.insuranceVerification.create.mockResolvedValue({ id: "ins-1" });

      await service.createDraftCarFromVerification("owner-1", "ver-1");
      await service.createDraftCarFromVerification("owner-1", "ver-1");

      const [first, second] = databaseServiceMock.insuranceVerification.create.mock.calls;
      expect(first?.[0]).toEqual(second?.[0]);
      expect(first?.[0]?.data.idempotencyKey).toBe("initial-insurance:ver-1");
      expect(first?.[0]?.data.requestHash).toBe(
        createHash("sha256")
          .update(JSON.stringify({ carId: "car-1", policyNumber: "TEST/POLICY/123" }))
          .digest("hex"),
      );
    });

    it("still creates the draft and skips insurance when the snapshot is already expired", async () => {
      databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: false });
      databaseServiceMock.vehicleVerification.findFirst.mockResolvedValueOnce({
        ...verification,
        insurancePolicyNumber: "TEST/POLICY/123",
        insurancePolicyStatus: "Active",
        insurancePolicyExpiresAt: new Date(Date.now() - 60_000),
      });
      databaseServiceMock.car.create.mockResolvedValueOnce({
        id: "car-1",
        ownerId: "owner-1",
        registrationNumber: "KJA123AB",
        chassisNumber: verification.chassisNumber,
      });
      databaseServiceMock.vehicleVerification.updateMany.mockResolvedValueOnce({ count: 1 });

      await expect(
        service.createDraftCarFromVerification("owner-1", "ver-1"),
      ).resolves.toMatchObject({ id: "car-1" });
      expect(databaseServiceMock.insuranceVerification.create).not.toHaveBeenCalled();
    });

    it("still creates the draft and skips insurance when the snapshot is missing", async () => {
      databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: false });
      databaseServiceMock.vehicleVerification.findFirst.mockResolvedValueOnce({
        ...verification,
        color: null,
        insurancePolicyNumber: null,
        insurancePolicyStatus: null,
        insurancePolicyExpiresAt: null,
      });
      databaseServiceMock.car.create.mockResolvedValueOnce({
        id: "car-1",
        ownerId: "owner-1",
        registrationNumber: "KJA123AB",
        chassisNumber: verification.chassisNumber,
      });
      databaseServiceMock.vehicleVerification.updateMany.mockResolvedValueOnce({ count: 1 });

      await expect(
        service.createDraftCarFromVerification("owner-1", "ver-1"),
      ).resolves.toMatchObject({ id: "car-1" });
      expect(databaseServiceMock.car.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ color: "" }),
        }),
      );
      expect(databaseServiceMock.insuranceVerification.create).not.toHaveBeenCalled();
    });

    it("fails when the verification is consumed concurrently", async () => {
      databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: false });
      databaseServiceMock.vehicleVerification.findFirst.mockResolvedValueOnce(verification);
      databaseServiceMock.car.create.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.vehicleVerification.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.createDraftCarFromVerification("owner-1", "ver-1"),
      ).rejects.toBeInstanceOf(CarCreateFailedException);
    });

    it("maps a duplicate chassis unique constraint", async () => {
      databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: false });
      databaseServiceMock.vehicleVerification.findFirst.mockResolvedValueOnce(verification);
      databaseServiceMock.car.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["chassisNumber"] },
        }),
      );

      await expect(
        service.createDraftCarFromVerification("owner-1", "ver-1"),
      ).rejects.toBeInstanceOf(ChassisNumberAlreadyExistsException);
    });
  });

  describe("submitCar", () => {
    const draftCar = {
      id: "car-1",
      ownerId: "owner-1",
      hourlyRate: null,
      dayRate: null,
      nightRate: null,
      fullDayRate: null,
      airportPickupRate: null,
      pricingIncludesFuel: false,
      fuelUpgradeRate: null,
      submittedAt: null,
      vehicleVerification: { id: "ver-1" },
      _count: { documents: 0, images: 0 },
    };

    it("derives missing document, image, pricing, and insurance requirements", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce(draftCar);
      databaseServiceMock.insuranceVerification.count.mockResolvedValueOnce(0);

      const error = await service.submitCar("car-1", "owner-1").catch((reason) => reason);

      expect(error).toBeInstanceOf(CarSubmissionRequirementsNotMetException);
      expect((error as CarSubmissionRequirementsNotMetException).getDetails()).toEqual({
        requirements: {
          hasDocuments: false,
          hasImages: false,
          hasPricing: false,
          hasInsuranceVerification: false,
        },
      });
    });

    it("treats fuel-inclusive pricing as complete without a fuel upgrade rate", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({
        ...draftCar,
        hourlyRate: 5000,
        dayRate: 50_000,
        nightRate: 60_000,
        fullDayRate: 100_000,
        airportPickupRate: 30_000,
        pricingIncludesFuel: true,
        fuelUpgradeRate: null,
        _count: { documents: 2, images: 1 },
      });
      databaseServiceMock.insuranceVerification.count.mockResolvedValueOnce(1);

      await expect(service.submitCar("car-1", "owner-1")).resolves.toEqual({
        success: true,
        requirements: {
          hasDocuments: true,
          hasImages: true,
          hasPricing: true,
          hasInsuranceVerification: true,
        },
      });
      expect(databaseServiceMock.insuranceVerification.count).toHaveBeenCalledWith({
        where: {
          carId: "car-1",
          ownerId: "owner-1",
          status: ProviderVerificationStatus.SUCCEEDED,
          policyExpiresAt: { gt: expect.any(Date) },
        },
      });
      expect(databaseServiceMock.car.update).toHaveBeenCalledWith({
        where: { id: "car-1" },
        data: { submittedAt: expect.any(Date) },
      });
    });

    it("blocks a verified car when unexpired insurance verification is missing", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({
        ...draftCar,
        hourlyRate: 5000,
        dayRate: 50_000,
        nightRate: 60_000,
        fullDayRate: 100_000,
        airportPickupRate: 30_000,
        pricingIncludesFuel: true,
        _count: { documents: 2, images: 1 },
      });
      databaseServiceMock.insuranceVerification.count.mockResolvedValueOnce(0);

      const error = await service.submitCar("car-1", "owner-1").catch((reason) => reason);

      expect(error).toBeInstanceOf(CarSubmissionRequirementsNotMetException);
      expect((error as CarSubmissionRequirementsNotMetException).getDetails()).toEqual({
        requirements: {
          hasDocuments: true,
          hasImages: true,
          hasPricing: true,
          hasInsuranceVerification: false,
        },
      });
      expect(databaseServiceMock.car.update).not.toHaveBeenCalled();
    });

    it("does not require insurance verification for a legacy unverified car", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({
        ...draftCar,
        vehicleVerification: null,
        hourlyRate: 5000,
        dayRate: 50_000,
        nightRate: 60_000,
        fullDayRate: 100_000,
        airportPickupRate: 30_000,
        pricingIncludesFuel: true,
        _count: { documents: 2, images: 1 },
      });

      await expect(service.submitCar("car-1", "owner-1")).resolves.toMatchObject({
        success: true,
        requirements: { hasInsuranceVerification: true },
      });
      expect(databaseServiceMock.insuranceVerification.count).not.toHaveBeenCalled();
    });
  });

  describe("draft asset and pricing updates", () => {
    it("uploads draft documents once and returns the owner car", async () => {
      databaseServiceMock.$transaction.mockImplementationOnce((arg) =>
        Array.isArray(arg) ? Promise.all(arg) : arg(databaseServiceMock),
      );
      databaseServiceMock.car.findFirst
        .mockResolvedValueOnce({ id: "car-1" })
        .mockResolvedValueOnce({ id: "car-1", documents: [] });
      storageServiceMock.uploadBuffer
        .mockResolvedValueOnce("owner-1/car-1/documents/mot.pdf")
        .mockResolvedValueOnce("owner-1/car-1/documents/insurance.pdf");
      databaseServiceMock.documentApproval.createMany.mockResolvedValueOnce({ count: 2 });
      databaseServiceMock.car.update.mockResolvedValueOnce({ id: "car-1" });

      const result = await service.uploadDraftCarDocuments("car-1", "owner-1", {
        motCertificate: createMockFile("mot.pdf", "application/pdf"),
        insuranceCertificate: createMockFile("insurance.pdf", "application/pdf"),
      });

      expect(result).toMatchObject({ id: "car-1" });
      expect(databaseServiceMock.documentApproval.createMany).toHaveBeenCalled();
    });

    it("rejects a second document upload for the same car", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1" });
      databaseServiceMock.documentApproval.count.mockResolvedValueOnce(2);

      await expect(
        service.uploadDraftCarDocuments("car-1", "owner-1", {
          motCertificate: createMockFile("mot.pdf", "application/pdf"),
          insuranceCertificate: createMockFile("insurance.pdf", "application/pdf"),
        }),
      ).rejects.toBeInstanceOf(CarAssetsAlreadyUploadedException);
    });

    it("uploads draft images once", async () => {
      databaseServiceMock.car.findFirst
        .mockResolvedValueOnce({ id: "car-1" })
        .mockResolvedValueOnce({ id: "car-1", images: [] });
      storageServiceMock.uploadBuffer.mockResolvedValueOnce("owner-1/car-1/images/a.jpg");
      databaseServiceMock.vehicleImage.createMany.mockResolvedValueOnce({ count: 1 });
      databaseServiceMock.car.update.mockResolvedValueOnce({ id: "car-1" });

      const result = await service.uploadDraftCarImages("car-1", "owner-1", [
        createMockFile("a.jpg", "image/jpeg"),
      ]);

      expect(result).toMatchObject({ id: "car-1" });
      expect(databaseServiceMock.vehicleImage.createMany).toHaveBeenCalled();
    });

    it("updates draft pricing through the shared car update path", async () => {
      databaseServiceMock.car.findFirst.mockResolvedValueOnce({
        id: "car-1",
        registrationNumber: "KJA123AB",
        status: Status.HOLD,
      });
      databaseServiceMock.car.update.mockResolvedValueOnce({
        id: "car-1",
        hourlyRate: 5000,
        dayRate: 50_000,
      });

      const result = await service.updateDraftCarPricing("car-1", "owner-1", {
        hourlyRate: 5000,
        dayRate: 50_000,
        nightRate: 60_000,
        fullDayRate: 100_000,
        airportPickupRate: 30_000,
        pricingIncludesFuel: true,
        vehicleType: VehicleType.SEDAN,
        serviceTier: ServiceTier.STANDARD,
      });

      expect(result).toMatchObject({ id: "car-1", hourlyRate: 5000, dayRate: 50_000 });
    });
  });
});
