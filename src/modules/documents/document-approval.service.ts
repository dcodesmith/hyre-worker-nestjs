import { Injectable } from "@nestjs/common";
import {
  CarApprovalStatus,
  ChauffeurApprovalStatus,
  DocumentStatus,
  type Prisma,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { CarApprovalService } from "../car/car-approval.service";
import { DatabaseService } from "../database/database.service";
import {
  DocumentApprovalFailedException,
  DocumentNotFoundException,
  DocumentsException,
} from "./documents.error";

const REJECTION_ACTION_NOTE =
  "Action required! Some of your documents/images were rejected. Please check the rejection notes and re-upload them.";

@Injectable()
export class DocumentApprovalService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly carApprovalService: CarApprovalService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DocumentApprovalService.name);
  }

  async approveDocument(documentId: string, approverId: string) {
    try {
      await this.assertDocumentExists(documentId);

      // Transaction keeps the document write and the car/chauffeur cascade
      // atomic; a failure in the cascade rolls the approval back too.
      const document = await this.databaseService.$transaction(async (tx) => {
        const updated = await tx.documentApproval.update({
          where: { id: documentId },
          data: {
            status: DocumentStatus.APPROVED,
            approvedById: approverId,
            approvedAt: new Date(),
          },
        });

        if (updated.carId) {
          await this.carApprovalService.approveCarIfFullyReviewed(updated.carId, tx);
        }

        if (updated.userId) {
          await this.approveChauffeurIfFullyReviewed(updated.userId, tx);
        }

        return updated;
      });

      return { success: true, document };
    } catch (error) {
      throw this.toApprovalError(error, "Failed to approve document", { documentId });
    }
  }

  async rejectDocument(documentId: string, approverId: string, notes: string) {
    try {
      await this.assertDocumentExists(documentId);

      const document = await this.databaseService.$transaction(async (tx) => {
        const updated = await tx.documentApproval.update({
          where: { id: documentId },
          data: {
            status: DocumentStatus.REJECTED,
            approvedById: approverId,
            approvedAt: new Date(),
            notes,
          },
        });

        if (updated.carId) {
          await tx.car.update({
            where: { id: updated.carId },
            data: {
              approvalStatus: CarApprovalStatus.PENDING,
              approvalNotes: REJECTION_ACTION_NOTE,
            },
          });
        }

        if (updated.userId) {
          await tx.user.update({
            where: { id: updated.userId },
            data: { chauffeurApprovalStatus: ChauffeurApprovalStatus.REJECTED },
          });
        }

        return updated;
      });

      return { success: true, document };
    } catch (error) {
      throw this.toApprovalError(error, "Failed to reject document", { documentId });
    }
  }

  private async assertDocumentExists(documentId: string): Promise<void> {
    const document = await this.databaseService.documentApproval.findUnique({
      where: { id: documentId },
      select: { id: true },
    });
    if (!document) {
      throw new DocumentNotFoundException();
    }
  }

  private async approveChauffeurIfFullyReviewed(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const unresolvedDocuments = await tx.documentApproval.count({
      where: { userId, status: { in: [DocumentStatus.PENDING, DocumentStatus.REJECTED] } },
    });

    if (unresolvedDocuments === 0) {
      await tx.user.update({
        where: { id: userId },
        data: { chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED },
      });
    }
  }

  private toApprovalError(
    error: unknown,
    message: string,
    context: Record<string, string>,
  ): DocumentsException {
    if (error instanceof DocumentsException) {
      return error;
    }
    this.logger.error(
      { ...context, error: error instanceof Error ? error.message : String(error) },
      message,
    );
    return new DocumentApprovalFailedException();
  }
}
