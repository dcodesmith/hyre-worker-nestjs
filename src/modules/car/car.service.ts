import { Injectable, Logger } from "@nestjs/common";
import { CarApprovalStatus, DocumentStatus, DocumentType, Prisma, Status } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import { StorageService } from "../storage/storage.service";
import { CAR_S3_CATEGORY_DOCUMENTS, CAR_S3_CATEGORY_IMAGES } from "./car.const";
import {
  CarCreateFailedException,
  CarException,
  CarFetchFailedException,
  CarNotFoundException,
  CarUpdateFailedException,
  FleetOwnerNotFoundException,
  OwnerDriverCarLimitReachedException,
  RegistrationNumberAlreadyExistsException,
} from "./car.error";
import type { CarCreateFiles, UploadedCarFile } from "./car.interface";
import type { CreateCarMultipartBodyDto } from "./dto/create-car.dto";
import type { UpdateCarBodyDto } from "./dto/update-car.dto";

@Injectable()
export class CarService {
  private readonly logger = new Logger(CarService.name);
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
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        createdAt: "asc",
      },
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
  ) {}

  private getObjectKey(ownerId: string, carId: string, fileName: string, category: string): string {
    const timestamp = Date.now();
    const safeFilename = `${timestamp}-${fileName.replaceAll(/[^a-zA-Z0-9.-]/g, "_")}`;
    return `${ownerId}/${carId}/${category}/${safeFilename}`;
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
  ): Promise<void> {
    const existingCar = await this.databaseService.car.findFirst({
      where: {
        ownerId,
        registrationNumber: {
          equals: registrationNumber.trim(),
          mode: "insensitive",
        },
      },
      select: { id: true },
    });

    if (existingCar) {
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
        registrationNumber: dto.registrationNumber,
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
  ): Promise<{
    imageUrls: string[];
    motCertificateUrl: string;
    insuranceCertificateUrl: string;
    uploadedKeys: string[];
  }> {
    const uploadedKeys: string[] = [];
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
        this.logger.error("Failed to delete uploaded car asset", {
          key,
          error: deleteError instanceof Error ? deleteError.message : String(deleteError),
        });
      }
    }
  }

  async listOwnerCars(ownerId: string) {
    try {
      return await this.databaseService.car.findMany({
        where: { ownerId },
        include: this.carDetailsInclude,
        orderBy: { updatedAt: "desc" },
      });
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      this.logger.error("Failed to list owner cars", {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
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

      return car;
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      this.logger.error("Failed to fetch owner car", {
        carId,
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new CarFetchFailedException();
    }
  }

  async createCar(ownerId: string, dto: CreateCarMultipartBodyDto, files: CarCreateFiles) {
    try {
      await this.assertOwnerCanCreateCar(ownerId);
      await this.assertRegistrationNumberUnique(ownerId, dto.registrationNumber);

      const createdCar = await this.createCarShell(ownerId, dto);
      const uploaded = await this.uploadCarFiles(ownerId, createdCar.id, files);

      try {
        return await this.persistUploadedCarAssets(createdCar.id, uploaded);
      } catch (error) {
        await this.cleanupFailedCreate(createdCar.id, uploaded.uploadedKeys);
        throw error;
      }
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      this.logger.error("Failed to create car", {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
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

      if (dto.registrationNumber && dto.registrationNumber !== existingCar.registrationNumber) {
        const duplicate = await this.databaseService.car.findFirst({
          where: {
            ownerId,
            id: { not: carId },
            registrationNumber: {
              equals: dto.registrationNumber.trim(),
              mode: "insensitive",
            },
          },
          select: { id: true },
        });
        if (duplicate) {
          throw new RegistrationNumberAlreadyExistsException(dto.registrationNumber);
        }
      }

      return await this.databaseService.car.update({
        where: { id: carId },
        data: {
          ...dto,
          fuelUpgradeRate:
            dto.pricingIncludesFuel === true ? null : (dto.fuelUpgradeRate ?? undefined),
        },
        include: this.carDetailsInclude,
      });
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      this.logger.error("Failed to update car", {
        carId,
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new CarUpdateFailedException();
    }
  }
}
