import { Test, type TestingModule } from "@nestjs/testing";
import { ChauffeurApprovalStatus, Prisma } from "@prisma/client";
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
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const carApprovalServiceMock = {
    approveCarIfFullyReviewed: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    // Run transaction callbacks against the same mock client.
    databaseServiceMock.$transaction.mockImplementation((cb) => cb(databaseServiceMock));
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

    // Cascade runs inside the transaction, sharing the same client
    expect(carApprovalServiceMock.approveCarIfFullyReviewed).toHaveBeenCalledWith(
      "car-1",
      databaseServiceMock,
    );
    expect(databaseServiceMock.user.update).not.toHaveBeenCalled();
  });

  it("approves a chauffeur once their last document is approved", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "doc-1",
      carId: null,
      userId: "user-1",
    });
    databaseServiceMock.documentApproval.count.mockResolvedValueOnce(0);

    await service.approveDocument("doc-1", "admin-1");

    expect(databaseServiceMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED },
    });
  });

  it("rejects a chauffeur document and flags the user", async () => {
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "doc-1",
      carId: null,
      userId: "user-1",
    });

    await service.rejectDocument("doc-1", "admin-1", "Expired");

    expect(databaseServiceMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { chauffeurApprovalStatus: ChauffeurApprovalStatus.REJECTED },
    });
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

  it("rolls back the document write when the cascade fails", async () => {
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
