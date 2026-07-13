import { Test, type TestingModule } from "@nestjs/testing";
import {
  CarApprovalStatus,
  DocumentStatus,
  Prisma,
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
  CarCreateFailedException,
  CarDocumentNotFoundException,
  CarFetchFailedException,
  CarNotFoundException,
  CarUpdateFailedException,
  FileNotRejectedException,
  OwnerDriverCarLimitReachedException,
  RegistrationNumberAlreadyExistsException,
  VehicleImageNotFoundException,
} from "./car.error";
import { CarService } from "./car.service";
import { CarPromotionEnrichmentService } from "./car-promotion.enrichment";

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
  const createCarDto = (registrationNumber = "ABC-123XY") => ({
    make: "Toyota",
    model: "Camry",
    year: 2022,
    color: "",
    registrationNumber,
    dayRate: 50000,
    hourlyRate: 5000,
    nightRate: 60000,
    fullDayRate: 100000,
    airportPickupRate: 30000,
    pricingIncludesFuel: false,
    fuelUpgradeRate: 10000,
    vehicleType: VehicleType.SEDAN,
    serviceTier: ServiceTier.STANDARD,
    passengerCapacity: 4,
  });
  const createCarFiles = () => ({
    images: [createMockFile("car.jpg", "image/jpeg")],
    motCertificate: createMockFile("mot.pdf", "application/pdf"),
    insuranceCertificate: createMockFile("insurance.pdf", "application/pdf"),
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
    },
    documentApproval: {
      createMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
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

  it("throws CarNotFoundException for unknown owner car", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce(null);

    await expect(service.getOwnerCarById("missing", "owner-1")).rejects.toBeInstanceOf(
      CarNotFoundException,
    );
  });

  it("enforces owner-driver single-car limit during create", async () => {
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: true });
    databaseServiceMock.car.count.mockResolvedValueOnce(1);

    await expect(
      service.createCar("owner-1", createCarDto(), createCarFiles()),
    ).rejects.toBeInstanceOf(OwnerDriverCarLimitReachedException);
  });

  it("rejects duplicate registration number for same owner (format-insensitive)", async () => {
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: false });
    databaseServiceMock.car.findMany.mockResolvedValueOnce([{ registrationNumber: "ABC123XY" }]);

    await expect(
      service.createCar("owner-1", createCarDto("ABC-123XY"), createCarFiles()),
    ).rejects.toBeInstanceOf(RegistrationNumberAlreadyExistsException);
  });

  it("creates car and related images/documents in transaction", async () => {
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: false });
    databaseServiceMock.car.findMany.mockResolvedValueOnce([]);
    databaseServiceMock.car.create.mockResolvedValueOnce({ id: "car-1" });
    storageServiceMock.uploadBuffer
      .mockResolvedValueOnce("https://cdn.example.com/car-1.jpg")
      .mockResolvedValueOnce("https://cdn.example.com/mot.pdf")
      .mockResolvedValueOnce("https://cdn.example.com/insurance.pdf");
    databaseServiceMock.$transaction.mockImplementationOnce(async (callback) =>
      callback({
        car: { findUnique: vi.fn().mockResolvedValue({ id: "car-1", ownerId: "owner-1" }) },
        vehicleImage: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
        documentApproval: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      }),
    );

    const result = await service.createCar("owner-1", createCarDto("ABC-123XY"), createCarFiles());

    expect(result).toEqual({ id: "car-1", ownerId: "owner-1" });
    expect(promotionServiceMock.getActivePromotionForCar).not.toHaveBeenCalled();
    expect(databaseServiceMock.car.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          registrationNumber: "ABC123XY",
        }),
      }),
    );
  });

  it("updates owner car", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce({
      id: "car-1",
      registrationNumber: "ABC-123XY",
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
  });

  it("rejects update when registration number conflicts after normalization", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce({
      id: "car-1",
      registrationNumber: "ZZZ-999AA",
    });
    databaseServiceMock.car.findMany.mockResolvedValueOnce([{ registrationNumber: "ABC123XY" }]);

    await expect(
      service.updateCar("car-1", "owner-1", { registrationNumber: "ABC 123XY" }),
    ).rejects.toBeInstanceOf(RegistrationNumberAlreadyExistsException);
  });

  it("deletes already-uploaded files when create fails mid-upload", async () => {
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: false });
    databaseServiceMock.car.findMany.mockResolvedValueOnce([]);
    databaseServiceMock.car.create.mockResolvedValueOnce({ id: "car-1" });
    databaseServiceMock.car.delete.mockResolvedValueOnce({ id: "car-1" });
    storageServiceMock.uploadBuffer
      .mockResolvedValueOnce("https://cdn.example.com/car-1.jpg")
      .mockRejectedValueOnce(new Error("s3 timeout"));
    storageServiceMock.deleteObjectByKey.mockResolvedValue(undefined);

    await expect(
      service.createCar("owner-1", createCarDto(), createCarFiles()),
    ).rejects.toBeInstanceOf(CarCreateFailedException);

    expect(databaseServiceMock.car.delete).toHaveBeenCalledWith({ where: { id: "car-1" } });
    expect(storageServiceMock.deleteObjectByKey.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(
      storageServiceMock.deleteObjectByKey.mock.calls.some(([key]) =>
        typeof key === "string" ? key.includes("owner-1/car-1/") : false,
      ),
    ).toBe(true);
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
      databaseServiceMock.vehicleImage.update.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Record not found", {
          code: "P2025",
          clientVersion: "test",
        }),
      );

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
      storageServiceMock.uploadBuffer.mockResolvedValueOnce("https://cdn.test/new.pdf");
      databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
        id: "doc-1",
        documentUrl: "https://cdn.test/new.pdf",
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
          documentUrl: "https://cdn.test/new.pdf",
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
  });
});
