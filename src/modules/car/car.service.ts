import { Injectable } from "@nestjs/common";
import {
  CarApprovalStatus,
  type DocumentApproval,
  DocumentStatus,
  DocumentType,
  Prisma,
  Status,
  type VehicleImage,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService, isRecordNotFoundError } from "../database/database.service";
import { StorageService } from "../storage/storage.service";
import { CAR_S3_CATEGORY_DOCUMENTS, CAR_S3_CATEGORY_IMAGES } from "./car.const";
import {
  CarCreateFailedException,
  CarDocumentNotFoundException,
  CarException,
  CarFetchFailedException,
  CarNotFoundException,
  CarUpdateFailedException,
  FileNotRejectedException,
  FleetOwnerNotFoundException,
  OwnerDriverCarLimitReachedException,
  RegistrationNumberAlreadyExistsException,
  VehicleImageNotFoundException,
} from "./car.error";
import type { CarCreateFiles, UploadedCarFile, UploadedFiles } from "./car.interface";
import { CarPromotionEnrichmentService } from "./car-promotion.enrichment";
import type { CreateCarMultipartBodyDto } from "./dto/create-car.dto";
import type { UpdateCarBodyDto } from "./dto/update-car.dto";

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

  private async assertOwnerCanCreateCar(ownerId: string): Promise<void> {
    const fleetOwnerUser = await this.databaseService.user.findUnique({
      where: { id: ownerId },
      select: { isOwnerDriver: true },
    });

    if (!fleetOwnerUser) {
      throw new FleetOwnerNotFoundException();
    }

    if (!fleetOwnerUser.isOwnerDriver) {
      return;
    }

    const existingCarsCount = await this.databaseService.car.count({
      where: { ownerId },
    });

    if (existingCarsCount >= 1) {
      throw new OwnerDriverCarLimitReachedException();
    }
  }

  private async assertRegistrationNumberUnique(
    ownerId: string,
    registrationNumber: string,
    excludeCarId?: string,
  ): Promise<void> {
    const normalizedRegistrationNumber = this.normalizeRegistrationNumber(registrationNumber);
    const existingCars = await this.databaseService.car.findMany({
      where: {
        ownerId,
        ...(excludeCarId && { id: { not: excludeCarId } }),
      },
      select: { registrationNumber: true },
    });

    const hasDuplicate = existingCars.some(
      (car) =>
        this.normalizeRegistrationNumber(car.registrationNumber) === normalizedRegistrationNumber,
    );
    if (hasDuplicate) {
      throw new RegistrationNumberAlreadyExistsException(registrationNumber);
    }
  }

  private async createCarShell(
    ownerId: string,
    dto: CreateCarMultipartBodyDto,
  ): Promise<{ id: string }> {
    return this.databaseService.car.create({
      data: {
        make: dto.make,
        model: dto.model,
        year: dto.year,
        color: dto.color,
        ownerId,
        registrationNumber: this.normalizeRegistrationNumber(dto.registrationNumber),
        status: dto.status ?? Status.AVAILABLE,
        approvalStatus: CarApprovalStatus.PENDING,
        hourlyRate: dto.hourlyRate,
        dayRate: dto.dayRate,
        nightRate: dto.nightRate,
        fuelUpgradeRate: dto.fuelUpgradeRate ?? null,
        fullDayRate: dto.fullDayRate,
        airportPickupRate: dto.airportPickupRate,
        pricingIncludesFuel: dto.pricingIncludesFuel,
        vehicleType: dto.vehicleType,
        serviceTier: dto.serviceTier,
        passengerCapacity: dto.passengerCapacity,
      },
      select: { id: true },
    });
  }

  private async uploadCarFiles(
    ownerId: string,
    carId: string,
    files: CarCreateFiles,
    uploadedKeys: string[],
  ): Promise<UploadedFiles> {
    const trackUpload = async (file: UploadedCarFile, category: string): Promise<string> => {
      const key = this.getObjectKey(ownerId, carId, file.originalname, category);
      const url = await this.storageService.uploadBuffer(file.buffer, key, file.mimetype);
      uploadedKeys.push(key);
      return url;
    };

    const [imageUrls, motCertificateUrl, insuranceCertificateUrl] = await Promise.all([
      Promise.all(files.images.map((image) => trackUpload(image, CAR_S3_CATEGORY_IMAGES))),
      trackUpload(files.motCertificate, CAR_S3_CATEGORY_DOCUMENTS),
      trackUpload(files.insuranceCertificate, CAR_S3_CATEGORY_DOCUMENTS),
    ]);

    return { imageUrls, motCertificateUrl, insuranceCertificateUrl, uploadedKeys };
  }

  private async persistUploadedCarAssets(
    carId: string,
    uploaded: {
      imageUrls: string[];
      motCertificateUrl: string;
      insuranceCertificateUrl: string;
    },
  ) {
    const car = await this.databaseService.$transaction(async (tx) => {
      await tx.vehicleImage.createMany({
        data: uploaded.imageUrls.map((url) => ({
          url,
          carId,
          status: DocumentStatus.PENDING,
        })),
      });

      await tx.documentApproval.createMany({
        data: [
          {
            documentType: DocumentType.MOT_CERTIFICATE,
            documentUrl: uploaded.motCertificateUrl,
            carId,
            status: DocumentStatus.PENDING,
          },
          {
            documentType: DocumentType.INSURANCE_CERTIFICATE,
            documentUrl: uploaded.insuranceCertificateUrl,
            carId,
            status: DocumentStatus.PENDING,
          },
        ],
      });

      return tx.car.findUnique({
        where: { id: carId },
        include: this.carDetailsInclude,
      });
    });

    if (!car) {
      throw new CarCreateFailedException();
    }

    return car;
  }

  private async cleanupFailedCreate(carId: string, uploadedKeys: string[]): Promise<void> {
    await this.databaseService.car.delete({
      where: { id: carId },
    });

    for (const key of uploadedKeys) {
      try {
        await this.storageService.deleteObjectByKey(key);
      } catch (deleteError) {
        this.logger.error(
          {
            key,
            error: deleteError instanceof Error ? deleteError.message : String(deleteError),
          },
          "Failed to delete uploaded car asset",
        );
      }
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

  async createCar(ownerId: string, dto: CreateCarMultipartBodyDto, files: CarCreateFiles) {
    try {
      await this.assertOwnerCanCreateCar(ownerId);
      await this.assertRegistrationNumberUnique(ownerId, dto.registrationNumber);

      const createdCar = await this.createCarShell(ownerId, dto);
      const uploadedKeys: string[] = [];

      try {
        const uploaded = await this.uploadCarFiles(ownerId, createdCar.id, files, uploadedKeys);
        return await this.persistUploadedCarAssets(createdCar.id, uploaded);
      } catch (error) {
        await this.cleanupFailedCreate(createdCar.id, uploadedKeys);
        throw error;
      }
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      this.logger.error(
        {
          ownerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to create car",
      );
      throw new CarCreateFailedException();
    }
  }

  async updateCar(carId: string, ownerId: string, dto: UpdateCarBodyDto) {
    try {
      const existingCar = await this.databaseService.car.findFirst({
        where: { id: carId, ownerId },
        select: { id: true, registrationNumber: true },
      });

      if (!existingCar) {
        throw new CarNotFoundException();
      }

      const normalizedRegistrationNumber = dto.registrationNumber
        ? this.normalizeRegistrationNumber(dto.registrationNumber)
        : undefined;

      if (
        normalizedRegistrationNumber &&
        normalizedRegistrationNumber !==
          this.normalizeRegistrationNumber(existingCar.registrationNumber)
      ) {
        await this.assertRegistrationNumberUnique(ownerId, dto.registrationNumber, carId);
      }

      const car = await this.databaseService.car.update({
        where: { id: carId },
        data: {
          ...dto,
          ...(normalizedRegistrationNumber && {
            registrationNumber: normalizedRegistrationNumber,
          }),
          fuelUpgradeRate:
            dto.pricingIncludesFuel === true ? null : (dto.fuelUpgradeRate ?? undefined),
        },
        include: this.carDetailsInclude,
      });
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
        "Failed to update car",
      );
      throw new CarUpdateFailedException();
    }
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
        // between the read above and this update cannot be clobbered.
        record = isImage
          ? await this.databaseService.vehicleImage.update({
              where: { id: fileId, status: DocumentStatus.REJECTED },
              data: { url, ...resetData },
            })
          : await this.databaseService.documentApproval.update({
              where: { id: fileId, status: DocumentStatus.REJECTED },
              data: { documentUrl: url, ...resetData },
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

  /** Best-effort cleanup of the replaced S3 object; failures are only logged. */
  private async deleteReplacedObject(previousUrl: string): Promise<void> {
    try {
      const key = new URL(previousUrl).pathname.slice(1);
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
