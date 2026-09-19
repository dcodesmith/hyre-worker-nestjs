import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  type InsuranceVerification,
  ProviderVerificationStatus,
  type VehicleVerification,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { CarNotFoundException } from "../car/car.error";
import { CarService } from "../car/car.service";
import { DatabaseService, isUniqueConstraintError } from "../database/database.service";
import { NhtsaError, NhtsaService } from "../nhtsa/nhtsa.service";
import { PremblyError, PremblyService } from "../prembly/prembly.service";
import type {
  CreateInsuranceVerificationDto,
  CreateVehicleVerificationDto,
} from "./vehicle-verification.dto";
import {
  InsuranceInactiveException,
  InsuranceVehicleMismatchException,
  ProviderVerificationException,
  VehicleMismatchException,
  VehicleNotEligibleException,
  VehicleVerificationAlreadyUsedException,
  VehicleVerificationExpiredException,
  VehicleVerificationNotFoundException,
  VerificationErrorCode,
  VerificationException,
  VerificationIdempotencyKeyReusedException,
  VerificationOperationFailedException,
  VerificationRequestInProgressException,
} from "./verification.error";

const MINIMUM_VEHICLE_YEAR = 2015;
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class VehicleVerificationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly premblyService: PremblyService,
    private readonly nhtsaService: NhtsaService,
    private readonly carService: CarService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(VehicleVerificationService.name);
  }

  async createVehicleVerification(
    ownerId: string,
    idempotencyKey: string,
    input: CreateVehicleVerificationDto,
  ) {
    const plateNumber = this.normalizePlate(input.plateNumber);
    const chassisNumber = input.chassisNumber.trim().toUpperCase();
    const requestHash = this.hash({ plateNumber, chassisNumber });

    let verification: VehicleVerification;
    try {
      verification = await this.databaseService.vehicleVerification.create({
        data: {
          ownerId,
          idempotencyKey,
          requestHash,
          plateNumber,
          chassisNumber,
          expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.databaseService.vehicleVerification.findUnique({
        where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } },
      });
      if (!existing) throw error;
      if (existing.requestHash !== requestHash) {
        throw new VerificationIdempotencyKeyReusedException();
      }
      if (existing.status === ProviderVerificationStatus.PROCESSING) {
        throw new VerificationRequestInProgressException();
      }
      if (existing.status === ProviderVerificationStatus.FAILED) {
        throw this.failureException(existing.failureReason);
      }
      return this.toVehicleResponse(existing);
    }

    try {
      const [plate, vin] = await Promise.all([
        this.premblyService.verifyPlate(plateNumber),
        this.verifyVin(chassisNumber),
      ]);
      this.assertVehicleDetailsMatch(plateNumber, chassisNumber, plate, vin);

      const completed = await this.databaseService.vehicleVerification.update({
        where: { id: verification.id },
        data: {
          status: ProviderVerificationStatus.SUCCEEDED,
          make: vin.make,
          model: vin.model,
          year: vin.year,
          color: plate.color,
          passengerCapacity: vin.passengerCapacity,
          plateProviderRef: plate.reference,
          vinProviderRef: vin.reference,
        },
      });
      return this.toVehicleResponse(completed);
    } catch (error) {
      throw await this.failVehicleVerification(verification.id, error);
    }
  }

  async getVehicleVerification(ownerId: string, verificationId: string) {
    const verification = await this.databaseService.vehicleVerification.findFirst({
      where: { id: verificationId, ownerId },
    });
    if (!verification) {
      throw new VehicleVerificationNotFoundException();
    }
    return this.toVehicleResponse(verification);
  }

  async createDraftCar(ownerId: string, verificationId: string) {
    const verification = await this.databaseService.vehicleVerification.findFirst({
      where: { id: verificationId, ownerId },
    });
    if (!verification) {
      throw new VehicleVerificationNotFoundException();
    }
    if (verification.status === ProviderVerificationStatus.FAILED) {
      throw this.failureException(verification.failureReason);
    }
    if (verification.status === ProviderVerificationStatus.PROCESSING) {
      throw new VerificationRequestInProgressException();
    }
    if (verification.expiresAt <= new Date()) {
      throw new VehicleVerificationExpiredException();
    }
    if (verification.carId) {
      throw new VehicleVerificationAlreadyUsedException();
    }
    if (!this.getEligibility(verification.year).isEligible) {
      throw new VehicleNotEligibleException();
    }

    return this.carService.createDraftCarFromVerification(ownerId, verificationId);
  }

  async createInsuranceVerification({
    ownerId,
    carId,
    idempotencyKey,
    input,
  }: {
    ownerId: string;
    carId: string;
    idempotencyKey: string;
    input: CreateInsuranceVerificationDto;
  }) {
    const car = await this.databaseService.car.findFirst({
      where: { id: carId, ownerId },
      select: { id: true, registrationNumber: true, chassisNumber: true },
    });
    if (!car) {
      throw new CarNotFoundException();
    }

    const policyNumber = input.policyNumber.trim().toUpperCase();
    const requestHash = this.hash({ carId, policyNumber });
    let verification: InsuranceVerification;
    try {
      verification = await this.databaseService.insuranceVerification.create({
        data: { ownerId, carId, idempotencyKey, requestHash, policyNumber },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.databaseService.insuranceVerification.findUnique({
        where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } },
      });
      if (!existing) throw error;
      if (existing.requestHash !== requestHash) {
        throw new VerificationIdempotencyKeyReusedException();
      }
      if (existing.status === ProviderVerificationStatus.PROCESSING) {
        throw new VerificationRequestInProgressException();
      }
      if (existing.status === ProviderVerificationStatus.FAILED) {
        throw this.failureException(existing.failureReason);
      }
      return this.toInsuranceResponse(existing);
    }

    try {
      const result = await this.premblyService.verifyInsurance(policyNumber);
      if (result.policyStatus.trim().toLowerCase() !== "active" || result.expiresAt <= new Date()) {
        throw new InsuranceInactiveException();
      }

      const plateMatches = result.plateNumbers.some(
        (plate) => this.normalizePlate(plate) === car.registrationNumber,
      );
      const chassisMatches =
        Boolean(result.chassisNumber) &&
        Boolean(car.chassisNumber) &&
        result.chassisNumber === car.chassisNumber;
      if (!plateMatches && !chassisMatches) {
        throw new InsuranceVehicleMismatchException();
      }

      const completed = await this.databaseService.insuranceVerification.update({
        where: { id: verification.id },
        data: {
          status: ProviderVerificationStatus.SUCCEEDED,
          policyNumber: result.policyNumber,
          policyStatus: result.policyStatus,
          policyExpiresAt: result.expiresAt,
          providerRef: result.reference,
        },
      });
      return this.toInsuranceResponse(completed);
    } catch (error) {
      throw await this.failInsuranceVerification(verification.id, error);
    }
  }

  private toVehicleResponse(verification: VehicleVerification) {
    return {
      id: verification.id,
      status: verification.status,
      vehicle: {
        plateNumber: verification.plateNumber,
        chassisNumber: verification.chassisNumber,
        make: verification.make,
        model: verification.model,
        year: verification.year,
        color: verification.color,
        passengerCapacity: verification.passengerCapacity,
      },
      eligibility: this.getEligibility(verification.year),
      expiresAt: verification.expiresAt,
      carId: verification.carId,
    };
  }

  private toInsuranceResponse(verification: InsuranceVerification) {
    return {
      id: verification.id,
      carId: verification.carId,
      status: verification.status,
      policyNumber: verification.policyNumber,
      policyStatus: verification.policyStatus,
      policyExpiresAt: verification.policyExpiresAt,
      providerRef: verification.providerRef,
      createdAt: verification.createdAt,
    };
  }

  private getEligibility(year: number | null) {
    const reasons =
      year !== null && year < MINIMUM_VEHICLE_YEAR ? ["VEHICLE_YEAR_BELOW_MINIMUM"] : [];
    return {
      isEligible: year !== null && reasons.length === 0,
      reasons,
    };
  }

  private normalizePlate(plateNumber: string): string {
    return plateNumber.toUpperCase().replaceAll(/[\s-]+/g, "");
  }

  private vehicleWords(value: string): string[] {
    return value
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter(Boolean);
  }

  private assertVehicleDetailsMatch(
    requestedPlate: string,
    requestedChassis: string,
    plate: { plateNumber: string; vehicleName: string; chassisNumber: string | null },
    vin: { make: string; model: string },
  ): void {
    if (this.normalizePlate(plate.plateNumber) !== requestedPlate) {
      throw new VehicleMismatchException();
    }
    if (plate.chassisNumber && plate.chassisNumber !== requestedChassis) {
      throw new VehicleMismatchException();
    }

    const plateVehicleName = plate.vehicleName;

    const plateWords = this.vehicleWords(plateVehicleName);
    const makeWords = this.vehicleWords(vin.make);
    const modelWords = this.vehicleWords(vin.model);
    const normalizedModel = modelWords.join("");
    const makeIndex = plateWords.findIndex((_, start) =>
      makeWords.every((word, offset) => plateWords[start + offset] === word),
    );
    const plateModelWords = plateWords.slice(makeIndex + makeWords.length);
    const modelMatches = plateModelWords.some((_, start) => {
      let candidate = "";
      for (const word of plateModelWords.slice(start)) {
        candidate += word;
        if (candidate === normalizedModel) return true;
        if (candidate.length >= normalizedModel.length) return false;
      }
      return false;
    });
    if (makeWords.length === 0 || modelWords.length === 0 || makeIndex < 0 || !modelMatches) {
      throw new VehicleMismatchException();
    }
  }

  private async verifyVin(chassisNumber: string) {
    try {
      const vin = await this.premblyService.verifyVin(chassisNumber);
      if (vin.passengerCapacity) {
        return vin;
      }
      try {
        const nhtsaVin = await this.nhtsaService.verifyVin(chassisNumber);
        return { ...vin, passengerCapacity: nhtsaVin.passengerCapacity };
      } catch {
        return vin;
      }
    } catch (error) {
      if (
        !(error instanceof PremblyError) ||
        !["UNAVAILABLE", "INVALID_RESPONSE"].includes(error.kind)
      ) {
        throw error;
      }
      const vin = await this.nhtsaService.verifyVin(chassisNumber);
      return { ...vin, reference: null };
    }
  }

  private hash(value: Record<string, string>): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private async failVehicleVerification(
    id: string,
    error: unknown,
  ): Promise<VerificationException> {
    const exception = this.toVerificationException(error);
    await this.databaseService.vehicleVerification
      .updateMany({
        where: { id, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: exception.getErrorCode(),
        },
      })
      .catch(() => undefined);
    return exception;
  }

  private async failInsuranceVerification(
    id: string,
    error: unknown,
  ): Promise<VerificationException> {
    const exception = this.toVerificationException(error);
    await this.databaseService.insuranceVerification
      .updateMany({
        where: { id, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: exception.getErrorCode(),
        },
      })
      .catch(() => undefined);
    return exception;
  }

  private toVerificationException(error: unknown): VerificationException {
    if (error instanceof VerificationException) return error;
    if (error instanceof PremblyError) {
      return new ProviderVerificationException(error.kind);
    }
    if (error instanceof NhtsaError) {
      return new ProviderVerificationException(error.kind);
    }
    this.logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Unexpected vehicle verification failure",
    );
    return new VerificationOperationFailedException();
  }

  private failureException(reason: string | null): VerificationException {
    switch (reason) {
      case VerificationErrorCode.PROVIDER_REJECTED:
        return new ProviderVerificationException("REJECTED");
      case VerificationErrorCode.PROVIDER_INVALID_RESPONSE:
        return new ProviderVerificationException("INVALID_RESPONSE");
      case VerificationErrorCode.PROVIDER_UNAVAILABLE:
        return new ProviderVerificationException("UNAVAILABLE");
      case VerificationErrorCode.VEHICLE_MISMATCH:
        return new VehicleMismatchException();
      case VerificationErrorCode.INSURANCE_INACTIVE:
        return new InsuranceInactiveException();
      case VerificationErrorCode.INSURANCE_VEHICLE_MISMATCH:
        return new InsuranceVehicleMismatchException();
      default:
        return new VerificationOperationFailedException();
    }
  }
}
