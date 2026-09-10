import { Test, type TestingModule } from "@nestjs/testing";
import { CarApprovalStatus, ChauffeurApprovalStatus, DocumentType, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { CarApprovalService } from "../car/car-approval.service";
import { DatabaseService } from "../database/database.service";
import { DocumentApprovalService } from "./document-approval.service";
import { DocumentApprovalFailedException, DocumentNotFoundException } from "./documents.error";

// Prisma throws P2025 when an update's where clause matches no record
const recordNotFoundError = () =>
  new Prisma.PrismaClientKnownRequestError("Record not found", {
    code: "P2025",
    clientVersion: "test",
  });

describe("DocumentApprovalService", () => {
  let service: DocumentApprovalService;

  const databaseServiceMock = {
    documentApproval: {
      update: vi.fn(),
      count: vi.fn(),
    },
    car: {
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  const carApprovalServiceMock = {
    approveCarIfFullyReviewed: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    // Run transaction callbacks against the same mock client.
    databaseServiceMock.$transaction.mockImplementation((cb) => cb(databaseServiceMock));
    // Row lock (SELECT ... FOR UPDATE) resolves to an existing car by default.
    databaseServiceMock.$queryRaw.mockResolvedValue([{ id: "car-1" }]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentApprovalService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: CarApprovalService, useValue: carApprovalServiceMock },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<DocumentApprovalService>(DocumentApprovalService);
  });

  it("delegates car re-evaluation when a car document is approved", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "doc-1",
      carId: "car-1",
      userId: null,
    });

    await service.approveDocument("doc-1", "admin-1");

    // Approving clears any stale rejection note on the document
    expect(databaseServiceMock.documentApproval.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ notes: null }) }),
    );
    // Cascade runs inside the transaction, sharing the same client
    expect(carApprovalServiceMock.approveCarIfFullyReviewed).toHaveBeenCalledWith(
      "car-1",
      databaseServiceMock,
    );
    expect(databaseServiceMock.user.update).not.toHaveBeenCalled();
  });

  it("does not change chauffeur state for a user who is not a chauffeur or owner-driver", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "doc-1",
      carId: null,
      userId: "user-1",
      documentType: DocumentType.NIN,
    });
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({
      fleetOwnerId: null,
      isOwnerDriver: false,
    });

    await service.approveDocument("doc-1", "admin-1");

    expect(databaseServiceMock.documentApproval.count).not.toHaveBeenCalled();
    expect(databaseServiceMock.user.update).not.toHaveBeenCalled();
  });

  it("does not auto-approve a chauffeur when no required documents are approved", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "doc-1",
      carId: null,
      userId: "user-1",
      documentType: DocumentType.NIN,
    });
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({
      fleetOwnerId: "fo-1",
      isOwnerDriver: false,
    });
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(0);

    await service.approveDocument("doc-1", "admin-1");

    expect(databaseServiceMock.documentApproval.count).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        documentType: { in: [DocumentType.NIN, DocumentType.DRIVERS_LICENSE] },
        status: "APPROVED",
      },
    });
    expect(databaseServiceMock.user.update).not.toHaveBeenCalled();
  });

  it("approves a chauffeur once every mandatory document is approved", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "doc-1",
      carId: null,
      userId: "user-1",
      documentType: DocumentType.DRIVERS_LICENSE,
    });
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({
      fleetOwnerId: "fo-1",
      isOwnerDriver: false,
    });
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(2);

    await service.approveDocument("doc-1", "admin-1");

    expect(databaseServiceMock.$queryRaw).toHaveBeenCalled();
    expect(databaseServiceMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED },
    });
  });

  it("approves an owner-driver when only the licence is approved", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "doc-1",
      carId: null,
      userId: "user-1",
      documentType: DocumentType.DRIVERS_LICENSE,
    });
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({
      fleetOwnerId: null,
      isOwnerDriver: true,
    });
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(1);

    await service.approveDocument("doc-1", "admin-1");

    expect(databaseServiceMock.documentApproval.count).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        documentType: { in: [DocumentType.DRIVERS_LICENSE] },
        status: "APPROVED",
      },
    });
    expect(databaseServiceMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED },
    });
  });

  it("approves a chauffeur even when optional LASDRI is still pending", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "lasdri-1",
      carId: null,
      userId: "user-1",
      documentType: DocumentType.LASDRI,
    });
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({
      fleetOwnerId: "fo-1",
      isOwnerDriver: false,
    });
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(2);

    await service.approveDocument("lasdri-1", "admin-1");

    expect(databaseServiceMock.documentApproval.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        documentType: { in: [DocumentType.NIN, DocumentType.DRIVERS_LICENSE] },
        status: "APPROVED",
      }),
    });
    expect(databaseServiceMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED },
    });
  });

  it("does not approve a chauffeur while a required document is still unresolved", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "lasdri-1",
      carId: null,
      userId: "user-1",
      documentType: DocumentType.LASDRI,
    });
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({
      fleetOwnerId: "fo-1",
      isOwnerDriver: false,
    });
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(1);

    await service.approveDocument("lasdri-1", "admin-1");

    expect(databaseServiceMock.user.update).not.toHaveBeenCalled();
  });

  it("rejects a required chauffeur document and flags the user", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "doc-1",
      carId: null,
      userId: "user-1",
      documentType: DocumentType.DRIVERS_LICENSE,
    });
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({
      fleetOwnerId: "fo-1",
      isOwnerDriver: false,
    });

    await service.rejectDocument("doc-1", "admin-1", "Expired");

    expect(databaseServiceMock.$queryRaw).toHaveBeenCalled();
    expect(databaseServiceMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { chauffeurApprovalStatus: ChauffeurApprovalStatus.REJECTED },
    });
  });

  it("does not flag a chauffeur when optional LASDRI is rejected", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "lasdri-1",
      carId: null,
      userId: "user-1",
      documentType: DocumentType.LASDRI,
    });
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({
      fleetOwnerId: "fo-1",
      isOwnerDriver: false,
    });

    await service.rejectDocument("lasdri-1", "admin-1", "Unreadable");

    expect(databaseServiceMock.user.update).not.toHaveBeenCalled();
  });

  it("rejects a car document and flags the car with an action-required note", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "doc-1",
      carId: "car-1",
      userId: null,
    });

    await service.rejectDocument("doc-1", "admin-1", "Expired");

    expect(databaseServiceMock.car.update).toHaveBeenCalledWith({
      where: { id: "car-1" },
      data: {
        approvalStatus: CarApprovalStatus.PENDING,
        approvalNotes: expect.stringContaining("Action required"),
      },
    });
    expect(databaseServiceMock.user.update).not.toHaveBeenCalled();
  });

  it("throws when approving a missing document", async () => {
    databaseServiceMock.documentApproval.update.mockRejectedValueOnce(recordNotFoundError());

    await expect(service.approveDocument("missing", "admin-1")).rejects.toBeInstanceOf(
      DocumentNotFoundException,
    );
    expect(carApprovalServiceMock.approveCarIfFullyReviewed).not.toHaveBeenCalled();
  });

  it("throws when rejecting a missing document", async () => {
    databaseServiceMock.documentApproval.update.mockRejectedValueOnce(recordNotFoundError());

    await expect(service.rejectDocument("missing", "admin-1", "Expired")).rejects.toBeInstanceOf(
      DocumentNotFoundException,
    );
    expect(databaseServiceMock.car.update).not.toHaveBeenCalled();
  });

  it("maps unexpected errors to DocumentApprovalFailedException without leaking them", async () => {
    databaseServiceMock.documentApproval.update.mockRejectedValueOnce(
      new Error("db connection lost"),
    );

    await expect(service.approveDocument("doc-1", "admin-1")).rejects.toBeInstanceOf(
      DocumentApprovalFailedException,
    );
  });

  it("fails the whole approval when the cascade fails inside the transaction", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "doc-1",
      carId: "car-1",
      userId: null,
    });
    carApprovalServiceMock.approveCarIfFullyReviewed.mockRejectedValueOnce(
      new Error("cascade failed"),
    );

    await expect(service.approveDocument("doc-1", "admin-1")).rejects.toBeInstanceOf(
      DocumentApprovalFailedException,
    );
    // The whole flow ran inside a single transaction
    expect(databaseServiceMock.$transaction).toHaveBeenCalledTimes(1);
  });
});
