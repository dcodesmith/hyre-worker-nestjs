import { Injectable } from "@nestjs/common";
import {
  CarApprovalStatus,
  type DocumentApproval,
  DocumentStatus,
  DocumentType,
  Prisma,
  ProviderVerificationStatus,
  Status,
  type VehicleImage,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import {
  DatabaseService,
  isRecordNotFoundError,
  isUniqueConstraintError,
  lockCarRow,
  lockUserRow,
} from "../database/database.service";
import { StorageService } from "../storage/storage.service";
import {
  CAR_S3_CATEGORY_DOCUMENTS,
  CAR_S3_CATEGORY_IMAGES,
  MAX_IMAGE_COUNT,
  REJECTION_ACTION_NOTE,
  REQUIRED_CAR_DOCUMENT_TYPES,
} from "./car.const";
import {
  CarAssetsAlreadyUploadedException,
  CarCreateFailedException,
  CarDocumentNotFoundException,
  CarException,
  CarFetchFailedException,
  CarNotFoundException,
  CarStatusUpdateNotAllowedException,
  CarSubmissionRequirementsNotMetException,
  CarUpdateFailedException,
  ChassisNumberAlreadyExistsException,
  FileNotRejectedException,
  FleetOwnerNotFoundException,
  OwnerDriverCarLimitReachedException,
  RegistrationNumberAlreadyExistsException,
  VehicleImageNotFoundException,
} from "./car.error";
import type { CarDocumentFiles, UploadedCarFile } from "./car.interface";
import { CarPromotionEnrichmentService } from "./car-promotion.enrichment";
import type { UpdateCarBodyDto } from "./dto/update-car.dto";
import type { UpdateCarPricingDto } from "./dto/update-car-pricing.dto";

@Injectable()
export class CarService {
  private readonly carDetailsInclude = Prisma.validator<Prisma.CarInclude>()({
    owner: {
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
      },
    },
    images: {
      select: {
        id: true,
        url: true,
        status: true,
        isPrimary: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    },
    documents: {
      orderBy: {
        createdAt: "asc",
      },
    },
  });

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storageService: StorageService,
    private readonly carPromotionEnrichmentService: CarPromotionEnrichmentService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CarService.name);
  }

  private getObjectKey(ownerId: string, carId: string, fileName: string, category: string): string {
    const timestamp = Date.now();
    const safeFilename = `${timestamp}-${fileName.replaceAll(/[^a-zA-Z0-9.-]/g, "_")}`;
    return `${ownerId}/${carId}/${category}/${safeFilename}`;
  }

  private normalizeRegistrationNumber(registrationNumber: string): string {
    return registrationNumber.toUpperCase().replaceAll(/\s+/g, "").replaceAll("-", "");
  }

  private async assertRegistrationNumberUnique(
    registrationNumber: string,
    excludeCarId?: string,
  ): Promise<void> {
    const normalizedRegistrationNumber = this.normalizeRegistrationNumber(registrationNumber);
    const existingCar = await this.databaseService.car.findFirst({
      where: {
        registrationNumber: normalizedRegistrationNumber,
        ...(excludeCarId && { id: { not: excludeCarId } }),
      },
      select: { id: true },
    });

    if (existingCar) {
      throw new RegistrationNumberAlreadyExistsException(registrationNumber);
    }
  }

  async listOwnerCars(ownerId: string) {
    try {
      const cars = await this.databaseService.car.findMany({
        where: { ownerId },
        include: this.carDetailsInclude,
        orderBy: { updatedAt: "desc" },
      });

      return await this.carPromotionEnrichmentService.enrichCarsWithPromotion({
        cars,
        referenceDate: new Date(),
        failureMessage: "Failed to enrich owner cars with promotions",
      });
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      this.logger.error(
        {
          ownerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to list owner cars",
      );
      throw new CarFetchFailedException();
    }
  }

  async getOwnerCarById(carId: string, ownerId: string) {
    try {
      const car = await this.databaseService.car.findFirst({
        where: { id: carId, ownerId },
        include: this.carDetailsInclude,
      });

      if (!car) {
        throw new CarNotFoundException();
      }

      return await this.carPromotionEnrichmentService.enrichCarWithPromotion({
        car,
        referenceDate: new Date(),
        failureMessage: "Failed to enrich owner car with promotion",
      });
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      this.logger.error(
        {
          carId,
          ownerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to fetch owner car",
      );
      throw new CarFetchFailedException();
    }
  }

  async createDraftCarFromVerification(ownerId: string, verificationId: string) {
    try {
      return await this.databaseService.$transaction(async (tx) => {
        if (!(await lockUserRow(tx, ownerId))) {
          throw new FleetOwnerNotFoundException();
        }
        const owner = await tx.user.findUnique({
          where: { id: ownerId },
          select: { isOwnerDriver: true },
        });
        if (owner?.isOwnerDriver && (await tx.car.count({ where: { ownerId } })) > 0) {
          throw new OwnerDriverCarLimitReachedException();
        }

        const verification = await tx.vehicleVerification.findFirst({
          where: {
            id: verificationId,
            ownerId,
            status: ProviderVerificationStatus.SUCCEEDED,
            carId: null,
            expiresAt: { gt: new Date() },
          },
        });
        if (
          !verification?.chassisNumber ||
          !verification.make ||
          !verification.model ||
          !verification.year ||
          !verification.passengerCapacity
        ) {
          throw new CarCreateFailedException();
        }

        const car = await tx.car.create({
          data: {
            ownerId,
            registrationNumber: this.normalizeRegistrationNumber(verification.plateNumber),
            chassisNumber: verification.chassisNumber,
            make: verification.make,
            model: verification.model,
            year: verification.year,
            color: verification.color ?? "",
            passengerCapacity: verification.passengerCapacity,
            status: Status.HOLD,
            approvalStatus: CarApprovalStatus.PENDING,
          },
          include: this.carDetailsInclude,
        });

        const consumed = await tx.vehicleVerification.updateMany({
          where: { id: verification.id, carId: null },
          data: { carId: car.id },
        });
        if (consumed.count !== 1) {
          throw new CarCreateFailedException();
        }
        return car;
      });
    } catch (error) {
      if (error instanceof CarException) throw error;
      if (isUniqueConstraintError(error)) {
        const target = String(error.meta?.target ?? "");
        if (target.includes("chassisNumber")) {
          throw new ChassisNumberAlreadyExistsException();
        }
        throw new RegistrationNumberAlreadyExistsException("this registration number");
      }
      this.logger.error(
        {
          ownerId,
          verificationId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to create verified draft car",
      );
      throw new CarCreateFailedException();
    }
  }

  async uploadDraftCarDocuments(carId: string, ownerId: string, files: CarDocumentFiles) {
    await this.assertCarBelongsToOwner(carId, ownerId);
    const existing = await this.databaseService.documentApproval.count({
      where: { carId, documentType: { in: [...REQUIRED_CAR_DOCUMENT_TYPES] } },
    });
    if (existing > 0) {
      throw new CarAssetsAlreadyUploadedException("documents");
    }

    const uploaded = await this.uploadFilesSequentially(
      ownerId,
      carId,
      [files.motCertificate, files.insuranceCertificate],
      CAR_S3_CATEGORY_DOCUMENTS,
    );
    try {
      await this.databaseService.$transaction([
        this.databaseService.documentApproval.createMany({
          data: [
            {
              documentType: DocumentType.MOT_CERTIFICATE,
              documentUrl: uploaded[0].url,
              carId,
            },
            {
              documentType: DocumentType.INSURANCE_CERTIFICATE,
              documentUrl: uploaded[1].url,
              carId,
            },
          ],
        }),
        this.databaseService.car.update({
          where: { id: carId },
          data: { approvalStatus: CarApprovalStatus.PENDING, submittedAt: null },
        }),
      ]);
    } catch (error) {
      await this.deleteUploadedKeys(uploaded.map(({ key }) => key));
      if (isUniqueConstraintError(error)) {
        throw new CarAssetsAlreadyUploadedException("documents");
      }
      throw error;
    }
    return this.getOwnerCarById(carId, ownerId);
  }

  async uploadDraftCarImages(carId: string, ownerId: string, images: UploadedCarFile[]) {
    await this.assertCarBelongsToOwner(carId, ownerId);
    const existing = await this.databaseService.vehicleImage.count({ where: { carId } });
    if (existing > 0 || existing + images.length > MAX_IMAGE_COUNT) {
      throw new CarAssetsAlreadyUploadedException("images");
    }

    const uploaded = await this.uploadFilesSequentially(
      ownerId,
      carId,
      images,
      CAR_S3_CATEGORY_IMAGES,
    );
    try {
      await this.databaseService.$transaction(async (tx) => {
        await lockCarRow(tx, carId);
        const currentImageCount = await tx.vehicleImage.count({ where: { carId } });
        if (currentImageCount > 0 || currentImageCount + uploaded.length > MAX_IMAGE_COUNT) {
          throw new CarAssetsAlreadyUploadedException("images");
        }
        await tx.vehicleImage.createMany({
          data: uploaded.map(({ url }) => ({ url, carId })),
        });
        await tx.car.update({
          where: { id: carId },
          data: { approvalStatus: CarApprovalStatus.PENDING, submittedAt: null },
        });
      });
    } catch (error) {
      await this.deleteUploadedKeys(uploaded.map(({ key }) => key));
      throw error;
    }
    return this.getOwnerCarById(carId, ownerId);
  }

  async updateDraftCarPricing(carId: string, ownerId: string, dto: UpdateCarPricingDto) {
    return this.updateCar(carId, ownerId, dto);
  }

  async submitCar(carId: string, ownerId: string) {
    const car = await this.databaseService.car.findFirst({
      where: { id: carId, ownerId },
      include: {
        vehicleVerification: { select: { id: true } },
        _count: {
          select: {
            documents: {
              where: { documentType: { in: [...REQUIRED_CAR_DOCUMENT_TYPES] } },
            },
            images: true,
          },
        },
      },
    });
    if (!car) {
      throw new CarNotFoundException();
    }

    const hasInsuranceVerification =
      !car.vehicleVerification ||
      (await this.databaseService.insuranceVerification.count({
        where: {
          carId,
          ownerId,
          status: ProviderVerificationStatus.SUCCEEDED,
          policyExpiresAt: { gt: new Date() },
        },
      })) > 0;
    const hasPricing =
      car.hourlyRate !== null &&
      car.dayRate !== null &&
      car.nightRate !== null &&
      car.fullDayRate !== null &&
      car.airportPickupRate !== null &&
      (car.pricingIncludesFuel || car.fuelUpgradeRate !== null);
    const requirements = {
      hasDocuments: car._count.documents === REQUIRED_CAR_DOCUMENT_TYPES.length,
      hasImages: car._count.images > 0,
      hasPricing,
      hasInsuranceVerification,
    };

    if (!Object.values(requirements).every(Boolean)) {
      throw new CarSubmissionRequirementsNotMetException(requirements);
    }

    if (!car.submittedAt) {
      await this.databaseService.car.update({
        where: { id: carId },
        data: { submittedAt: new Date() },
      });
    }
    return { success: true, requirements };
  }

  async updateCar(carId: string, ownerId: string, dto: UpdateCarBodyDto) {
    try {
      return await this.applyCarUpdate(carId, ownerId, dto);
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      if (dto.registrationNumber && isUniqueConstraintError(error)) {
        throw new RegistrationNumberAlreadyExistsException(dto.registrationNumber);
      }
      if (dto.status !== undefined && isRecordNotFoundError(error)) {
        throw new CarStatusUpdateNotAllowedException();
      }
      this.logger.error(
        {
          carId,
          ownerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to update car",
      );
      throw new CarUpdateFailedException();
    }
  }

  private async applyCarUpdate(carId: string, ownerId: string, dto: UpdateCarBodyDto) {
    const existingCar = await this.databaseService.car.findFirst({
      where: { id: carId, ownerId },
      select: { id: true, registrationNumber: true, status: true },
    });

    if (!existingCar) {
      throw new CarNotFoundException();
    }

    if (existingCar.status === Status.BOOKED && dto.status !== undefined) {
      throw new CarStatusUpdateNotAllowedException();
    }

    const normalizedRegistrationNumber = dto.registrationNumber
      ? this.normalizeRegistrationNumber(dto.registrationNumber)
      : undefined;

    if (
      normalizedRegistrationNumber &&
      normalizedRegistrationNumber !==
        this.normalizeRegistrationNumber(existingCar.registrationNumber)
    ) {
      await this.assertRegistrationNumberUnique(dto.registrationNumber, carId);
    }

    const updatesListingDetails = Object.keys(dto).some((field) => field !== "status");
    const car = await this.databaseService.car.update({
      where: {
        id: carId,
        ...(dto.status !== undefined && { status: { not: Status.BOOKED } }),
      },
      data: {
        ...dto,
        ...(normalizedRegistrationNumber && {
          registrationNumber: normalizedRegistrationNumber,
        }),
        fuelUpgradeRate:
          dto.pricingIncludesFuel === true ? null : (dto.fuelUpgradeRate ?? undefined),
        ...(updatesListingDetails && {
          approvalStatus: CarApprovalStatus.PENDING,
          submittedAt: null,
        }),
      },
      include: this.carDetailsInclude,
    });
    return this.carPromotionEnrichmentService.enrichCarWithPromotion({
      car,
      referenceDate: new Date(),
      failureMessage: "Failed to enrich owner car with promotion",
    });
  }

  /**
   * Replace a rejected vehicle image with a new file. The image goes back to
   * PENDING so admins re-review it; rejection metadata is cleared.
   */
  async replaceCarImage(carId: string, ownerId: string, imageId: string, file: UploadedCarFile) {
    const image = await this.replaceRejectedFile(carId, ownerId, imageId, file, "image");
    return { success: true, image };
  }

  /**
   * Replace a rejected car document (MOT/insurance) with a new file. The
   * document goes back to PENDING so admins re-review it.
   */
  async replaceCarDocument(
    carId: string,
    ownerId: string,
    documentId: string,
    file: UploadedCarFile,
  ) {
    const document = await this.replaceRejectedFile(carId, ownerId, documentId, file, "document");
    return { success: true, document };
  }

  private async replaceRejectedFile(
    carId: string,
    ownerId: string,
    fileId: string,
    file: UploadedCarFile,
    kind: "image" | "document",
  ): Promise<VehicleImage | DocumentApproval> {
    const isImage = kind === "image";
    try {
      await this.assertCarBelongsToOwner(carId, ownerId);

      const existing = isImage
        ? await this.databaseService.vehicleImage.findFirst({
            where: { id: fileId, carId },
            select: { id: true, status: true, url: true },
          })
        : await this.databaseService.documentApproval
            .findFirst({
              where: { id: fileId, carId },
              select: { id: true, status: true, documentUrl: true },
            })
            .then((document) => document && { ...document, url: document.documentUrl });
      if (!existing) {
        throw isImage ? new VehicleImageNotFoundException() : new CarDocumentNotFoundException();
      }
      if (existing.status !== DocumentStatus.REJECTED) {
        throw new FileNotRejectedException(kind);
      }

      const category = isImage ? CAR_S3_CATEGORY_IMAGES : CAR_S3_CATEGORY_DOCUMENTS;
      const key = this.getObjectKey(ownerId, carId, file.originalname, category);
      const url = await this.storageService.uploadBuffer(file.buffer, key, file.mimetype);

      const resetData = {
        status: DocumentStatus.PENDING,
        notes: null,
        approvedById: null,
        approvedAt: null,
      };

      let record: VehicleImage | DocumentApproval;
      try {
        // Guard on status in the write itself so a concurrent admin decision
        // between the read above and this update cannot be clobbered. Demote
        // the car too — approveCar can leave APPROVED while rejected assets
        // remain; re-upload must pull the listing out of public search.
        record = await this.databaseService.$transaction(async (tx) => {
          // Asset lock before car lock — same order as approve/reject paths,
          // so concurrent moderation + re-upload cannot deadlock.
          const updated = isImage
            ? await tx.vehicleImage.update({
                where: { id: fileId, status: DocumentStatus.REJECTED },
                data: { url, ...resetData },
              })
            : await tx.documentApproval.update({
                where: { id: fileId, status: DocumentStatus.REJECTED },
                data: { documentUrl: url, ...resetData },
              });
          // Serialize with concurrent approval so this demotion can't be overwritten.
          await lockCarRow(tx, carId);
          await tx.car.update({
            where: { id: carId },
            data: {
              approvalStatus: CarApprovalStatus.PENDING,
              approvalNotes: REJECTION_ACTION_NOTE,
            },
          });
          return updated;
        });
      } catch (updateError) {
        await this.storageService.deleteObjectByKey(key).catch(() => undefined);
        if (isRecordNotFoundError(updateError)) {
          throw new FileNotRejectedException(kind);
        }
        throw updateError;
      }

      await this.deleteReplacedObject(existing.url);

      return record;
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      this.logger.error(
        {
          carId,
          ownerId,
          fileId,
          error: error instanceof Error ? error.message : String(error),
        },
        `Failed to replace car ${kind}`,
      );
      throw new CarUpdateFailedException();
    }
  }

  private async assertCarBelongsToOwner(carId: string, ownerId: string): Promise<void> {
    const car = await this.databaseService.car.findFirst({
      where: { id: carId, ownerId },
      select: { id: true },
    });
    if (!car) {
      throw new CarNotFoundException();
    }
  }

  private async uploadFilesSequentially(
    ownerId: string,
    carId: string,
    files: UploadedCarFile[],
    category: string,
  ): Promise<Array<{ key: string; url: string }>> {
    const uploaded: Array<{ key: string; url: string }> = [];
    try {
      for (const file of files) {
        const key = this.getObjectKey(ownerId, carId, file.originalname, category);
        const url = await this.storageService.uploadBuffer(file.buffer, key, file.mimetype);
        uploaded.push({ key, url });
      }
      return uploaded;
    } catch (error) {
      await this.deleteUploadedKeys(uploaded.map(({ key }) => key));
      throw error;
    }
  }

  private async deleteUploadedKeys(keys: string[]): Promise<void> {
    await Promise.all(
      keys.map((key) => this.storageService.deleteObjectByKey(key).catch(() => undefined)),
    );
  }

  /** Best-effort cleanup of the replaced S3 object; failures are only logged. */
  private async deleteReplacedObject(previousUrl: string): Promise<void> {
    try {
      const key = previousUrl.includes("://")
        ? new URL(previousUrl).pathname.slice(1)
        : previousUrl;
      if (key) {
        await this.storageService.deleteObjectByKey(key);
      }
    } catch (error) {
      this.logger.warn(
        {
          previousUrl,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to delete replaced car asset",
      );
    }
  }
}
