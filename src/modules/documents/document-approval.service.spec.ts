import { Test, type TestingModule } from "@nestjs/testing";
import { ChauffeurApprovalStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { CarApprovalService } from "../car/car-approval.service";
import { DatabaseService } from "../database/database.service";
import { DocumentApprovalService } from "./document-approval.service";
import { DocumentNotFoundException } from "./documents.error";

describe("DocumentApprovalService", () => {
  let service: DocumentApprovalService;

  const databaseServiceMock = {
    documentApproval: {
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    car: {
      update: vi.fn(),
    },
    user: {
      update: vi.fn(),
    },
  };
  const carApprovalServiceMock = {
    approveCarIfFullyReviewed: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
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
    databaseServiceMock.documentApproval.findUnique.mockResolvedValueOnce({ id: "doc-1" });
    databaseServiceMock.documentApproval.update.mockResolvedValueOnce({
      id: "doc-1",
      carId: "car-1",
      userId: null,
    });

    await service.approveDocument("doc-1", "admin-1");

    expect(carApprovalServiceMock.approveCarIfFullyReviewed).toHaveBeenCalledWith("car-1");
    expect(databaseServiceMock.user.update).not.toHaveBeenCalled();
  });

  it("approves a chauffeur once their last document is approved", async () => {
    databaseServiceMock.documentApproval.findUnique.mockResolvedValueOnce({ id: "doc-1" });
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
    databaseServiceMock.documentApproval.findUnique.mockResolvedValueOnce({ id: "doc-1" });
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
    databaseServiceMock.documentApproval.findUnique.mockResolvedValueOnce(null);

    await expect(service.approveDocument("missing", "admin-1")).rejects.toBeInstanceOf(
      DocumentNotFoundException,
    );
    expect(databaseServiceMock.documentApproval.update).not.toHaveBeenCalled();
  });
});
