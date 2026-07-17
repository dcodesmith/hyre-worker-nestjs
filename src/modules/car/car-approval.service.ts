import { Injectable } from "@nestjs/common";
import { CarApprovalStatus, DocumentStatus, Prisma } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService, isRecordNotFoundError } from "../database/database.service";
import { REJECTION_ACTION_NOTE, REQUIRED_CAR_DOCUMENT_TYPES } from "./car.const";
import {
  CarApprovalBlockedException,
  CarApprovalFailedException,
  CarException,
  CarNotFoundException,
  VehicleImageNotFoundException,
} from "./car.error";
import type { ListCarsForReviewQueryDto } from "./dto/car-approval.dto";

@Injectable()
export class CarApprovalService {
  private readonly carReviewInclude = Prisma.validator<Prisma.CarInclude>()({
    owner: {
      select: { id: true, name: true, username: true, email: true },
    },
    images: {
      select: {
        id: true,
        url: true,
        status: true,
        isPrimary: true,
        notes: true,
        approvedById: true,
        approvedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ isPrimary: "desc" as const }, { createdAt: "asc" as const }],
    },
    documents: {
      orderBy: { createdAt: "asc" as const },
    },
  });

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CarApprovalService.name);
  }

  async listCarsForReview(query: ListCarsForReviewQueryDto) {
    try {
      const where: Prisma.CarWhereInput = query.approvalStatus
        ? { approvalStatus: query.approvalStatus }
        : {};

      const [cars, total] = await Promise.all([
        this.databaseService.car.findMany({
          where,
          include: this.carReviewInclude,
          orderBy: { updatedAt: "desc" },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        this.databaseService.car.count({ where }),
      ]);

      return {
        cars,
        meta: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      };
    } catch (error) {
      throw this.toApprovalError(error, "Failed to list cars for review", {
        approvalStatus: query.approvalStatus ?? "ALL",
      });
    }
  }

  async getCarForReview(carId: string) {
    try {
      const car = await this.databaseService.car.findUnique({
        where: { id: carId },
        include: this.carReviewInclude,
      });

      if (!car) {
        throw new CarNotFoundException();
      }

      return car;
    } catch (error) {
      throw this.toApprovalError(error, "Failed to fetch car for review", { carId });
    }
  }

  async approveCar(carId: string) {
    try {
      const existing = await this.databaseService.car.findUnique({
        where: { id: carId },
        select: { id: true },
      });
      if (!existing) {
        throw new CarNotFoundException();
      }

      // A car can only be approved once every image and document is approved.
      const approved = await this.approveCarIfFullyReviewed(carId);
      if (!approved) {
        throw new CarApprovalBlockedException();
      }

      const car = await this.databaseService.car.findUnique({ where: { id: carId } });
      return { success: true, car };
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      if (isRecordNotFoundError(error)) {
        throw new CarNotFoundException();
      }
      throw this.toApprovalError(error, "Failed to approve car", { carId });
    }
  }

  async approveImage(carId: string, imageId: string, approverId: string) {
    try {
      const image = await this.databaseService.$transaction(async (tx) => {
        // The carId in the where clause scopes the update to the right car;
        // Prisma throws P2025 when the image is missing or belongs elsewhere.
        const updated = await tx.vehicleImage.update({
          where: { id: imageId, carId },
          data: {
            status: DocumentStatus.APPROVED,
            approvedById: approverId,
            approvedAt: new Date(),
            notes: null,
          },
        });

        await this.approveCarIfFullyReviewed(carId, tx);

        return updated;
      });

      return { success: true, image };
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw new VehicleImageNotFoundException();
      }
      throw this.toApprovalError(error, "Failed to approve vehicle image", { carId, imageId });
    }
  }

  async rejectImage(carId: string, imageId: string, approverId: string, notes: string) {
    try {
      const image = await this.databaseService.$transaction(async (tx) => {
        const updated = await tx.vehicleImage.update({
          where: { id: imageId, carId },
          data: {
            status: DocumentStatus.REJECTED,
            approvedById: approverId,
            approvedAt: new Date(),
            notes,
            isPrimary: false,
          },
        });

        await tx.car.update({
          where: { id: carId },
          data: { approvalStatus: CarApprovalStatus.PENDING, approvalNotes: REJECTION_ACTION_NOTE },
        });

        return updated;
      });

      return { success: true, image };
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw new VehicleImageNotFoundException();
      }
      throw this.toApprovalError(error, "Failed to reject vehicle image", { carId, imageId });
    }
  }

  async setCoverImage(carId: string, imageId: string) {
    try {
      await this.databaseService.$transaction(async (tx) => {
        const target = await tx.vehicleImage.findFirst({
          where: { id: imageId, carId, status: DocumentStatus.APPROVED },
          select: { id: true },
        });
        if (!target) {
          throw new VehicleImageNotFoundException();
        }

        await tx.vehicleImage.updateMany({
          where: { carId, isPrimary: true, NOT: { id: imageId } },
          data: { isPrimary: false },
        });
        await tx.vehicleImage.update({
          where: { id: imageId },
          data: { isPrimary: true },
        });
      });

      return { success: true };
    } catch (error) {
      throw this.toApprovalError(error, "Failed to set cover image", { carId, imageId });
    }
  }

  /**
   * Promote the car to APPROVED only when it actually has the required assets
   * AND every image and document is APPROVED. A car with no approved images, a
   * missing required document, or any PENDING/REJECTED item is not promotable
   * (guards the "zero-doc" hole where an empty car would otherwise auto-approve).
   * Returns whether the car ended up approved. Exported so the documents domain
   * can trigger it; accepts an optional tx so callers can make the cascade atomic.
   */
  async approveCarIfFullyReviewed(carId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    const db = tx ?? this.databaseService;
    const unresolvedFilter = {
      carId,
      status: { in: [DocumentStatus.PENDING, DocumentStatus.REJECTED] },
    };

    const [unresolvedDocuments, unresolvedImages, approvedImageCount, approvedRequiredDocs] =
      await Promise.all([
        db.documentApproval.count({ where: unresolvedFilter }),
        db.vehicleImage.count({ where: unresolvedFilter }),
        db.vehicleImage.count({ where: { carId, status: DocumentStatus.APPROVED } }),
        db.documentApproval.findMany({
          where: {
            carId,
            status: DocumentStatus.APPROVED,
            documentType: { in: [...REQUIRED_CAR_DOCUMENT_TYPES] },
          },
          select: { documentType: true },
          distinct: ["documentType"],
        }),
      ]);

    const hasAllRequiredDocuments = REQUIRED_CAR_DOCUMENT_TYPES.every((type) =>
      approvedRequiredDocs.some((doc) => doc.documentType === type),
    );

    const fullyReviewed =
      unresolvedDocuments === 0 &&
      unresolvedImages === 0 &&
      approvedImageCount > 0 &&
      hasAllRequiredDocuments;

    if (fullyReviewed) {
      await db.car.update({
        where: { id: carId },
        data: { approvalStatus: CarApprovalStatus.APPROVED, approvalNotes: null },
      });
    }

    return fullyReviewed;
  }

  private toApprovalError(
    error: unknown,
    message: string,
    context: Record<string, string>,
  ): CarException {
    if (error instanceof CarException) {
      return error;
    }

    this.logger.error(
      { ...context, error: error instanceof Error ? error.message : String(error) },
      message,
    );
    return new CarApprovalFailedException();
  }
}
