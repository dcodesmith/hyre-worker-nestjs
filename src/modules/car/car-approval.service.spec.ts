import { Test, type TestingModule } from "@nestjs/testing";
import { CarApprovalStatus, DocumentStatus, DocumentType, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import {
  CarApprovalBlockedException,
  CarNotFoundException,
  VehicleImageNotFoundException,
} from "./car.error";
import { CarApprovalService } from "./car-approval.service";

const approvedRequiredDocs = [
  { documentType: DocumentType.MOT_CERTIFICATE },
  { documentType: DocumentType.INSURANCE_CERTIFICATE },
];

// Prisma throws P2025 when an update's where clause matches no record
const recordNotFoundError = () =>
  new Prisma.PrismaClientKnownRequestError("Record not found", {
    code: "P2025",
    clientVersion: "test",
  });

describe("CarApprovalService", () => {
  let service: CarApprovalService;

  const databaseServiceMock = {
    vehicleImage: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    documentApproval: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    car: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: run transaction callbacks against the same mock client.
    databaseServiceMock.$transaction.mockImplementation((cb) => cb(databaseServiceMock));
    // Safe defaults so approveCarIfFullyReviewed's extra reads never throw;
    // individual tests override with mockResolvedValueOnce for sequencing.
    databaseServiceMock.documentApproval.count.mockResolvedValue(0);
    databaseServiceMock.vehicleImage.count.mockResolvedValue(0);
    databaseServiceMock.documentApproval.findMany.mockResolvedValue([]);
    // Row lock (SELECT ... FOR UPDATE) resolves to an existing car by default.
    databaseServiceMock.$queryRaw.mockResolvedValue([{ id: "car-1" }]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [CarApprovalService, { provide: DatabaseService, useValue: databaseServiceMock }],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<CarApprovalService>(CarApprovalService);
  });

  it("approves the car once the last pending image is approved", async () => {
    databaseServiceMock.vehicleImage.update.mockResolvedValueOnce({ id: "img-1", carId: "car-1" });
    // Fully reviewed: nothing unresolved, an approved image exists, required docs present.
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(0);
    databaseServiceMock.vehicleImage.count
      .mockResolvedValueOnce(0) // unresolved images
      .mockResolvedValueOnce(2); // approved images
    databaseServiceMock.documentApproval.findMany.mockResolvedValueOnce(approvedRequiredDocs);

    await service.approveImage("car-1", "img-1", "admin-1");

    // Approving clears any stale rejection note on the image
    expect(databaseServiceMock.vehicleImage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ notes: null }) }),
    );
    expect(databaseServiceMock.car.update).toHaveBeenCalledWith({
      where: { id: "car-1" },
      data: { approvalStatus: CarApprovalStatus.APPROVED, approvalNotes: null },
    });
  });

  it("does not approve the car while items remain pending", async () => {
    databaseServiceMock.vehicleImage.update.mockResolvedValueOnce({ id: "img-1", carId: "car-1" });
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(1);
    databaseServiceMock.vehicleImage.count.mockResolvedValueOnce(0);

    await service.approveImage("car-1", "img-1", "admin-1");

    expect(databaseServiceMock.car.update).not.toHaveBeenCalled();
  });

  it("does not approve the car while rejected items remain unresolved", async () => {
    databaseServiceMock.vehicleImage.update.mockResolvedValueOnce({ id: "img-1", carId: "car-1" });
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(0);
    // One REJECTED image still counts as unresolved
    databaseServiceMock.vehicleImage.count.mockResolvedValueOnce(1);

    await service.approveImage("car-1", "img-1", "admin-1");

    expect(databaseServiceMock.vehicleImage.count).toHaveBeenCalledWith({
      where: {
        carId: "car-1",
        status: { in: [DocumentStatus.PENDING, DocumentStatus.REJECTED] },
      },
    });
    expect(databaseServiceMock.car.update).not.toHaveBeenCalled();
  });

  it("does not approve a car that has no approved images", async () => {
    databaseServiceMock.vehicleImage.update.mockResolvedValueOnce({ id: "img-1", carId: "car-1" });
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(0);
    databaseServiceMock.vehicleImage.count
      .mockResolvedValueOnce(0) // unresolved images
      .mockResolvedValueOnce(0); // no approved images
    databaseServiceMock.documentApproval.findMany.mockResolvedValueOnce(approvedRequiredDocs);

    await service.approveImage("car-1", "img-1", "admin-1");

    expect(databaseServiceMock.car.update).not.toHaveBeenCalled();
  });

  it("does not approve a car that is missing a required document", async () => {
    databaseServiceMock.vehicleImage.update.mockResolvedValueOnce({ id: "img-1", carId: "car-1" });
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(0);
    databaseServiceMock.vehicleImage.count
      .mockResolvedValueOnce(0) // unresolved images
      .mockResolvedValueOnce(2); // approved images
    // Only MOT approved; insurance missing.
    databaseServiceMock.documentApproval.findMany.mockResolvedValueOnce([
      { documentType: DocumentType.MOT_CERTIFICATE },
    ]);

    await service.approveImage("car-1", "img-1", "admin-1");

    expect(databaseServiceMock.car.update).not.toHaveBeenCalled();
  });

  it("rejects approving an image that does not belong to the car", async () => {
    databaseServiceMock.vehicleImage.update.mockRejectedValueOnce(recordNotFoundError());

    await expect(service.approveImage("car-1", "stale", "admin-1")).rejects.toBeInstanceOf(
      VehicleImageNotFoundException,
    );
    // The update is scoped to the car, so the cascade never runs
    expect(databaseServiceMock.vehicleImage.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "stale", carId: "car-1" } }),
    );
    expect(databaseServiceMock.car.update).not.toHaveBeenCalled();
  });

  it("sets the car back to PENDING when an image is rejected", async () => {
    databaseServiceMock.vehicleImage.update.mockResolvedValueOnce({ id: "img-1", carId: "car-1" });

    await service.rejectImage("car-1", "img-1", "admin-1", "Blurry photo");

    // A rejected image must lose its cover flag so search ordering stays correct
    expect(databaseServiceMock.vehicleImage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DocumentStatus.REJECTED,
          isPrimary: false,
        }),
      }),
    );
    expect(databaseServiceMock.car.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "car-1" },
        data: expect.objectContaining({ approvalStatus: CarApprovalStatus.PENDING }),
      }),
    );
  });

  it("throws CarNotFoundException when approving an unknown car", async () => {
    // Row lock returns no rows => car does not exist.
    databaseServiceMock.$queryRaw.mockResolvedValueOnce([]);

    await expect(service.approveCar("missing")).rejects.toBeInstanceOf(CarNotFoundException);
    expect(databaseServiceMock.car.update).not.toHaveBeenCalled();
  });

  it("approveCar approves a car whose documents are all approved", async () => {
    databaseServiceMock.car.findUnique.mockResolvedValueOnce({
      id: "car-1",
      approvalStatus: CarApprovalStatus.APPROVED,
    });
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(0);
    databaseServiceMock.vehicleImage.count
      .mockResolvedValueOnce(0) // unresolved
      .mockResolvedValueOnce(3); // approved
    databaseServiceMock.documentApproval.findMany.mockResolvedValueOnce(approvedRequiredDocs);

    const result = await service.approveCar("car-1");

    expect(result.success).toBe(true);
    expect(databaseServiceMock.car.update).toHaveBeenCalledWith({
      where: { id: "car-1" },
      data: { approvalStatus: CarApprovalStatus.APPROVED, approvalNotes: null },
    });
  });

  it("approveCar is blocked when images/documents are not all approved", async () => {
    // One document still pending.
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(1);

    await expect(service.approveCar("car-1")).rejects.toBeInstanceOf(CarApprovalBlockedException);
    expect(databaseServiceMock.car.update).not.toHaveBeenCalled();
  });

  it("sets exactly one cover image atomically, restricted to approved images", async () => {
    const tx = {
      vehicleImage: {
        findFirst: vi.fn().mockResolvedValueOnce({ id: "img-2" }),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
        update: vi.fn().mockResolvedValueOnce({ id: "img-2", isPrimary: true }),
      },
    };
    databaseServiceMock.$transaction.mockImplementationOnce((cb) => cb(tx));

    await service.setCoverImage("car-1", "img-2");

    expect(tx.vehicleImage.findFirst).toHaveBeenCalledWith({
      where: { id: "img-2", carId: "car-1", status: DocumentStatus.APPROVED },
      select: { id: true },
    });
    expect(tx.vehicleImage.updateMany).toHaveBeenCalledWith({
      where: { carId: "car-1", isPrimary: true, NOT: { id: "img-2" } },
      data: { isPrimary: false },
    });
    expect(tx.vehicleImage.update).toHaveBeenCalledWith({
      where: { id: "img-2" },
      data: { isPrimary: true },
    });
  });

  it("rejects setting a cover image that does not belong to the car or is not approved", async () => {
    const tx = {
      vehicleImage: {
        findFirst: vi.fn().mockResolvedValueOnce(null),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
    };
    databaseServiceMock.$transaction.mockImplementationOnce((cb) => cb(tx));

    await expect(service.setCoverImage("car-1", "stale")).rejects.toBeInstanceOf(
      VehicleImageNotFoundException,
    );
    expect(tx.vehicleImage.updateMany).not.toHaveBeenCalled();
  });

  describe("listCarsForReview", () => {
    it("filters by approval status and paginates", async () => {
      databaseServiceMock.car.findMany.mockResolvedValueOnce([{ id: "car-1" }]);
      databaseServiceMock.car.count.mockResolvedValueOnce(41);

      const result = await service.listCarsForReview({
        approvalStatus: CarApprovalStatus.PENDING,
        page: 2,
        limit: 20,
      });

      expect(databaseServiceMock.car.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { approvalStatus: CarApprovalStatus.PENDING },
          orderBy: { updatedAt: "desc" },
          skip: 20,
          take: 20,
        }),
      );
      expect(result.cars).toEqual([{ id: "car-1" }]);
      expect(result.meta).toEqual({ page: 2, limit: 20, total: 41, totalPages: 3 });
    });

    it("lists all cars when no status filter is provided", async () => {
      databaseServiceMock.car.findMany.mockResolvedValueOnce([]);
      databaseServiceMock.car.count.mockResolvedValueOnce(0);

      const result = await service.listCarsForReview({ page: 1, limit: 20 });

      expect(databaseServiceMock.car.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
      expect(result.meta.total).toBe(0);
    });
  });

  describe("getCarForReview", () => {
    it("returns the car with its documents and images", async () => {
      const car = { id: "car-1", documents: [], images: [] };
      databaseServiceMock.car.findUnique.mockResolvedValueOnce(car);

      const result = await service.getCarForReview("car-1");

      expect(result).toEqual(car);
      expect(databaseServiceMock.car.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "car-1" } }),
      );
    });

    it("throws CarNotFoundException for an unknown car", async () => {
      databaseServiceMock.car.findUnique.mockResolvedValueOnce(null);

      await expect(service.getCarForReview("missing")).rejects.toBeInstanceOf(CarNotFoundException);
    });
  });
});
