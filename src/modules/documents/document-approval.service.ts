import { Injectable } from "@nestjs/common";
import {
  CarApprovalStatus,
  ChauffeurApprovalStatus,
  DocumentStatus,
  DocumentType,
  type Prisma,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { toLogError } from "../../common/logging/error-logging.helper";
import { REJECTION_ACTION_NOTE } from "../car/car.const";
import { CarApprovalService } from "../car/car-approval.service";
import {
  DatabaseService,
  isRecordNotFoundError,
  lockCarRow,
  lockUserRow,
} from "../database/database.service";
import {
  DocumentApprovalFailedException,
  DocumentNotFoundException,
  DocumentsException,
} from "./documents.error";

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
      // Transaction keeps the document write and the car/chauffeur cascade
      // atomic; a failure in the cascade rolls the approval back too.
      const document = await this.databaseService.$transaction(async (tx) => {
        const updated = await tx.documentApproval.update({
          where: { id: documentId },
          data: {
            status: DocumentStatus.APPROVED,
            approvedById: approverId,
            approvedAt: new Date(),
            notes: null,
          },
        });

        if (updated.carId) {
          await this.carApprovalService.approveCarIfFullyReviewed(updated.carId, tx);
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
          // Serialize with concurrent approval so this demotion can't be overwritten.
          await lockCarRow(tx, updated.carId);
          await tx.car.update({
            where: { id: updated.carId },
            data: {
              approvalStatus: CarApprovalStatus.PENDING,
              approvalNotes: REJECTION_ACTION_NOTE,
            },
          });
        }

        if (updated.userId) {
          await lockUserRow(tx, updated.userId);
          if (await this.isRequiredChauffeurDocument(updated.userId, updated.documentType, tx)) {
            await tx.user.update({
              where: { id: updated.userId },
              data: { chauffeurApprovalStatus: ChauffeurApprovalStatus.REJECTED },
            });
          }
        }

        return updated;
      });

      return { success: true, document };
    } catch (error) {
      throw this.toApprovalError(error, "Failed to reject document", { documentId });
    }
  }

  private async isRequiredChauffeurDocument(
    userId: string,
    documentType: DocumentType,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { isOwnerDriver: true },
    });
    return Boolean(user?.isOwnerDriver && documentType === DocumentType.DRIVERS_LICENSE);
  }

  private toApprovalError(
    error: unknown,
    message: string,
    context: Record<string, string>,
  ): DocumentsException {
    if (error instanceof DocumentsException) {
      return error;
    }
    // P2025: the update's where clause matched no document.
    if (isRecordNotFoundError(error)) {
      return new DocumentNotFoundException();
    }
    this.logger.error({ ...context, err: toLogError(error) }, message);
    return new DocumentApprovalFailedException();
  }
}
