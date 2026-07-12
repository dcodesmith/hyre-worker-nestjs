import { Injectable } from "@nestjs/common";
import { CarApprovalStatus, ChauffeurApprovalStatus, DocumentStatus } from "@prisma/client";
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

      const document = await this.databaseService.documentApproval.update({
        where: { id: documentId },
        data: {
          status: DocumentStatus.APPROVED,
          approvedById: approverId,
          approvedAt: new Date(),
        },
      });

      if (document.carId) {
        await this.carApprovalService.approveCarIfFullyReviewed(document.carId);
      }

      if (document.userId) {
        await this.approveChauffeurIfFullyReviewed(document.userId);
      }

      return { success: true, document };
    } catch (error) {
      throw this.toApprovalError(error, "Failed to approve document", { documentId });
    }
  }

  async rejectDocument(documentId: string, approverId: string, notes: string) {
    try {
      await this.assertDocumentExists(documentId);

      const document = await this.databaseService.documentApproval.update({
        where: { id: documentId },
        data: {
          status: DocumentStatus.REJECTED,
          approvedById: approverId,
          approvedAt: new Date(),
          notes,
        },
      });

      if (document.carId) {
        await this.databaseService.car.update({
          where: { id: document.carId },
          data: { approvalStatus: CarApprovalStatus.PENDING, approvalNotes: REJECTION_ACTION_NOTE },
        });
      }

      if (document.userId) {
        await this.databaseService.user.update({
          where: { id: document.userId },
          data: { chauffeurApprovalStatus: ChauffeurApprovalStatus.REJECTED },
        });
      }

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

  private async approveChauffeurIfFullyReviewed(userId: string): Promise<void> {
    const pendingDocuments = await this.databaseService.documentApproval.count({
      where: { userId, status: DocumentStatus.PENDING },
    });

    if (pendingDocuments === 0) {
      await this.databaseService.user.update({
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
