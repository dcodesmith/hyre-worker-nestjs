import { createHash } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { Prisma, ProviderVerificationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { minimumVehicleYear } from "../car/car.const";
import { CarNotFoundException } from "../car/car.error";
import { CarService } from "../car/car.service";
import { DatabaseService } from "../database/database.service";
import { NhtsaError, NhtsaService } from "../nhtsa/nhtsa.service";
import { PremblyError, PremblyService } from "../prembly/prembly.service";
import {
  createInsuranceVerificationSchema,
  createVehicleVerificationSchema,
} from "./vehicle-verification.dto";
import { PREMBLY_VIN_BUDGET_MS, VehicleVerificationService } from "./vehicle-verification.service";
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
  VerificationIdempotencyKeyReusedException,
  VerificationRequestInProgressException,
} from "./verification.error";

const OWNER_ID = "owner-1";
const OTHER_OWNER_ID = "owner-2";
const IDEMPOTENCY_KEY = "verify-key-1";
const PLATE = "KJA-123AB";
const NORMALIZED_PLATE = "KJA123AB";
const CHASSIS = "1HGCM82633A004352";
const VERIFICATION_ID = "ver-1";
const POLICY_NUMBER = "TEST/POLICY/123";

const uniqueConstraintError = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });

const hash = (value: Record<string, string>) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const requestHash = hash({ plateNumber: NORMALIZED_PLATE, chassisNumber: CHASSIS });

const futureExpiry = () => new Date(Date.now() + 60 * 60 * 1000);
const pastExpiry = () => new Date(Date.now() - 60 * 1000);

const processingRecord = (overrides: Record<string, unknown> = {}) => ({
  id: VERIFICATION_ID,
  ownerId: OWNER_ID,
  idempotencyKey: IDEMPOTENCY_KEY,
  requestHash,
  plateNumber: NORMALIZED_PLATE,
  chassisNumber: CHASSIS,
  make: null,
  model: null,
  year: null,
  color: null,
  passengerCapacity: null,
  status: ProviderVerificationStatus.PROCESSING,
  failureReason: null,
  expiresAt: futureExpiry(),
  carId: null,
  plateProviderRef: null,
  vinProviderRef: null,
  ...overrides,
});

const succeededRecord = (overrides: Record<string, unknown> = {}) =>
  processingRecord({
    status: ProviderVerificationStatus.SUCCEEDED,
    make: "Toyota",
    model: "Camry",
    year: 2020,
    color: "Black",
    passengerCapacity: 5,
    plateProviderRef: "plate-ref",
    vinProviderRef: "vin-ref",
    ...overrides,
  });

const succeededResponse = {
  id: VERIFICATION_ID,
  status: ProviderVerificationStatus.SUCCEEDED,
  vehicle: {
    plateNumber: NORMALIZED_PLATE,
    chassisNumber: CHASSIS,
    make: "Toyota",
    model: "Camry",
    year: 2020,
    color: "Black",
    passengerCapacity: 5,
  },
  eligibility: { isEligible: true, reasons: [], minimumYear: minimumVehicleYear() },
  carId: null,
};

describe("createVehicleVerificationSchema", () => {
  it("accepts plate and chassis and uppercases the VIN", () => {
    const parsed = createVehicleVerificationSchema.safeParse({
      plateNumber: "kja-123ab",
      chassisNumber: `  ${CHASSIS.toLowerCase()}  `,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        plateNumber: "KJA-123AB",
        chassisNumber: CHASSIS,
      });
    }
  });

  it.each([
    [{ plateNumber: PLATE }, "chassisNumber"],
    [{ chassisNumber: CHASSIS }, "plateNumber"],
    [{ plateNumber: "not-a-plate", chassisNumber: CHASSIS }, "plateNumber"],
    [{ plateNumber: PLATE, chassisNumber: "1HGCM82633A00435" }, "chassisNumber"],
    [{ plateNumber: PLATE, chassisNumber: "1HGCM82633A00435I" }, "chassisNumber"],
    [{ plateNumber: PLATE, policyNumber: POLICY_NUMBER }, "chassisNumber"],
  ])("rejects %j", (input, field) => {
    const parsed = createVehicleVerificationSchema.safeParse(input);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes(field))).toBe(true);
    }
  });
});

describe("createInsuranceVerificationSchema", () => {
  it("accepts and trims a policy number", () => {
    const parsed = createInsuranceVerificationSchema.safeParse({ policyNumber: "  pol-123  " });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.policyNumber).toBe("pol-123");
    }
  });

  it("rejects a missing or too-short policy number", () => {
    expect(createInsuranceVerificationSchema.safeParse({}).success).toBe(false);
    expect(createInsuranceVerificationSchema.safeParse({ policyNumber: "ab" }).success).toBe(false);
  });
});

describe("VehicleVerificationService", () => {
  let service: VehicleVerificationService;
  let databaseService: {
    vehicleVerification: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    insuranceVerification: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    car: { findFirst: ReturnType<typeof vi.fn> };
  };
  let premblyService: {
    verifyPlate: ReturnType<typeof vi.fn>;
    verifyVin: ReturnType<typeof vi.fn>;
    verifyInsurance: ReturnType<typeof vi.fn>;
  };
  let nhtsaService: { verifyVin: ReturnType<typeof vi.fn> };
  let carService: { createDraftCarFromVerification: ReturnType<typeof vi.fn> };

  const mockPlate = {
    plateNumber: PLATE,
    vehicleName: "Toyota Camry",
    chassisNumber: null,
    color: "Black",
    reference: "plate-ref",
  };
  const mockVin = {
    year: 2020,
    make: "Toyota",
    model: "Camry",
    passengerCapacity: 5,
    reference: "vin-ref",
  };
  const mockNhtsaVin = {
    year: 2020,
    make: "Toyota",
    model: "Camry",
    passengerCapacity: 5,
  };

  const mockSuccessfulProviders = () => {
    premblyService.verifyPlate.mockResolvedValueOnce(mockPlate);
    premblyService.verifyVin.mockResolvedValueOnce(mockVin);
    databaseService.vehicleVerification.update.mockResolvedValueOnce(succeededRecord());
  };

  beforeEach(async () => {
    databaseService = {
      vehicleVerification: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      insuranceVerification: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      car: { findFirst: vi.fn() },
    };
    premblyService = {
      verifyPlate: vi.fn(),
      verifyVin: vi.fn(),
      verifyInsurance: vi.fn(),
    };
    nhtsaService = { verifyVin: vi.fn() };
    carService = { createDraftCarFromVerification: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VehicleVerificationService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: PremblyService, useValue: premblyService },
        { provide: NhtsaService, useValue: nhtsaService },
        { provide: CarService, useValue: carService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(VehicleVerificationService);
  });

  describe("createVehicleVerification", () => {
    it("hashes plate and chassis, looks up plate plus Prembly VIN, and persists the snapshot", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      mockSuccessfulProviders();

      const result = await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: "kja-123 ab",
        chassisNumber: `  ${CHASSIS.toLowerCase()}  `,
      });

      expect(databaseService.vehicleVerification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ownerId: OWNER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          requestHash,
          plateNumber: NORMALIZED_PLATE,
          chassisNumber: CHASSIS,
        }),
      });
      expect(premblyService.verifyPlate).toHaveBeenCalledWith(NORMALIZED_PLATE);
      expect(premblyService.verifyVin).toHaveBeenCalledWith(CHASSIS);
      expect(nhtsaService.verifyVin).toHaveBeenCalledWith(CHASSIS);
      expect(premblyService.verifyInsurance).not.toHaveBeenCalled();
      expect(databaseService.vehicleVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: {
          status: ProviderVerificationStatus.SUCCEEDED,
          make: "Toyota",
          model: "Camry",
          year: 2020,
          color: "Black",
          passengerCapacity: 5,
          plateProviderRef: "plate-ref",
          vinProviderRef: "vin-ref",
        },
      });
      expect(result).toMatchObject(succeededResponse);
      expect(result).not.toHaveProperty("insurance");
      expect(result).not.toHaveProperty("policyNumber");
    });

    it("treats a Prembly seat count below 4 as missing and uses NHTSA when it is in range", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce(mockPlate);
      premblyService.verifyVin.mockResolvedValueOnce({ ...mockVin, passengerCapacity: 3 });
      nhtsaService.verifyVin.mockResolvedValueOnce(mockNhtsaVin);
      databaseService.vehicleVerification.update.mockResolvedValueOnce(succeededRecord());

      await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: PLATE,
        chassisNumber: CHASSIS,
      });

      expect(nhtsaService.verifyVin).toHaveBeenCalledWith(CHASSIS);
      expect(databaseService.vehicleVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({ passengerCapacity: 5 }),
      });
    });

    it("supplements Prembly VIN with NHTSA seats when Prembly omits passenger capacity", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce(mockPlate);
      premblyService.verifyVin.mockResolvedValueOnce({ ...mockVin, passengerCapacity: 0 });
      nhtsaService.verifyVin.mockResolvedValueOnce(mockNhtsaVin);
      databaseService.vehicleVerification.update.mockResolvedValueOnce(succeededRecord());

      await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: PLATE,
        chassisNumber: CHASSIS,
      });

      expect(nhtsaService.verifyVin).toHaveBeenCalledWith(CHASSIS);
      expect(databaseService.vehicleVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          passengerCapacity: 5,
          vinProviderRef: "vin-ref",
        }),
      });
    });

    it("falls back to NHTSA when Prembly VIN is unavailable", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce(mockPlate);
      premblyService.verifyVin.mockRejectedValueOnce(new PremblyError("UNAVAILABLE"));
      nhtsaService.verifyVin.mockResolvedValueOnce(mockNhtsaVin);
      databaseService.vehicleVerification.update.mockResolvedValueOnce(
        succeededRecord({ vinProviderRef: null }),
      );

      await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: PLATE,
        chassisNumber: CHASSIS,
      });

      expect(nhtsaService.verifyVin).toHaveBeenCalledWith(CHASSIS);
      expect(databaseService.vehicleVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          passengerCapacity: 5,
          vinProviderRef: null,
        }),
      });
    });

    it("falls back to NHTSA when Prembly VIN returns an invalid response", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce(mockPlate);
      premblyService.verifyVin.mockRejectedValueOnce(new PremblyError("INVALID_RESPONSE"));
      nhtsaService.verifyVin.mockResolvedValueOnce(mockNhtsaVin);
      databaseService.vehicleVerification.update.mockResolvedValueOnce(
        succeededRecord({ vinProviderRef: null }),
      );

      await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: PLATE,
        chassisNumber: CHASSIS,
      });

      expect(nhtsaService.verifyVin).toHaveBeenCalledWith(CHASSIS);
    });

    it("does not use NHTSA when Prembly VIN is rejected", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce(mockPlate);
      premblyService.verifyVin.mockRejectedValueOnce(new PremblyError("REJECTED"));
      nhtsaService.verifyVin.mockResolvedValueOnce(mockNhtsaVin);

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        }),
      ).rejects.toBeInstanceOf(ProviderVerificationException);
      expect(databaseService.vehicleVerification.update).not.toHaveBeenCalled();
    });

    it("uses NHTSA when Prembly VIN exceeds the budget", async () => {
      vi.useFakeTimers();
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce(mockPlate);
      premblyService.verifyVin.mockReturnValueOnce(new Promise(() => {}));
      nhtsaService.verifyVin.mockResolvedValueOnce(mockNhtsaVin);
      databaseService.vehicleVerification.update.mockResolvedValueOnce(
        succeededRecord({ vinProviderRef: null }),
      );

      try {
        const pending = service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        });
        await vi.advanceTimersByTimeAsync(PREMBLY_VIN_BUDGET_MS);
        await pending;
      } finally {
        vi.useRealTimers();
      }

      expect(nhtsaService.verifyVin).toHaveBeenCalledWith(CHASSIS);
      expect(databaseService.vehicleVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          passengerCapacity: 5,
          vinProviderRef: null,
        }),
      });
    });

    it("succeeds with null passenger capacity when neither decoder returns seats", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce(mockPlate);
      premblyService.verifyVin.mockResolvedValueOnce({ ...mockVin, passengerCapacity: 0 });
      nhtsaService.verifyVin.mockResolvedValueOnce({ ...mockNhtsaVin, passengerCapacity: null });
      databaseService.vehicleVerification.update.mockResolvedValueOnce(
        succeededRecord({ passengerCapacity: null }),
      );

      const result = await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: PLATE,
        chassisNumber: CHASSIS,
      });

      expect(databaseService.vehicleVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          status: ProviderVerificationStatus.SUCCEEDED,
          passengerCapacity: null,
        }),
      });
      expect(result.vehicle.passengerCapacity).toBeNull();
    });

    it("keeps a Prembly VIN when NHTSA has no seat count either", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce(mockPlate);
      premblyService.verifyVin.mockRejectedValueOnce(new PremblyError("UNAVAILABLE"));
      nhtsaService.verifyVin.mockResolvedValueOnce({ ...mockNhtsaVin, passengerCapacity: null });
      databaseService.vehicleVerification.update.mockResolvedValueOnce(
        succeededRecord({ passengerCapacity: null, vinProviderRef: null }),
      );

      const result = await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: PLATE,
        chassisNumber: CHASSIS,
      });

      expect(nhtsaService.verifyVin).toHaveBeenCalledWith(CHASSIS);
      expect(result.vehicle.passengerCapacity).toBeNull();
    });

    it("accepts a plate vehicle name that includes the VIN make and model", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce({
        ...mockPlate,
        vehicleName: "2020 TOYOTA CAMRY XLE",
      });
      premblyService.verifyVin.mockResolvedValueOnce(mockVin);
      databaseService.vehicleVerification.update.mockResolvedValueOnce(succeededRecord());

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        }),
      ).resolves.toMatchObject(succeededResponse);
    });

    it("rejects a plate vehicle name that does not match the VIN make and model", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce({
        ...mockPlate,
        vehicleName: "Honda Accord",
      });
      premblyService.verifyVin.mockResolvedValueOnce(mockVin);

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        }),
      ).rejects.toBeInstanceOf(VehicleMismatchException);

      expect(databaseService.vehicleVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.VEHICLE_MISMATCH,
        },
      });
    });

    it("does not match a make embedded inside another vehicle-name word", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce({
        ...mockPlate,
        vehicleName: "Oxford Edge",
      });
      premblyService.verifyVin.mockResolvedValueOnce({
        ...mockVin,
        make: "Ford",
        model: "Edge",
      });

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        }),
      ).rejects.toBeInstanceOf(VehicleMismatchException);
    });

    it("does not match a model embedded inside another vehicle-name word", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce({
        ...mockPlate,
        vehicleName: "Ford Knowledge",
      });
      premblyService.verifyVin.mockResolvedValueOnce({
        ...mockVin,
        make: "Ford",
        model: "Edge",
      });

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        }),
      ).rejects.toBeInstanceOf(VehicleMismatchException);
    });

    it("rejects a plate lookup that returns a different registry chassis", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce({
        ...mockPlate,
        chassisNumber: "1HGCM82633A999999",
      });
      premblyService.verifyVin.mockResolvedValueOnce(mockVin);

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        }),
      ).rejects.toBeInstanceOf(VehicleMismatchException);
    });

    it("accepts a plate lookup that returns the same registry chassis", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce({
        ...mockPlate,
        chassisNumber: CHASSIS,
      });
      premblyService.verifyVin.mockResolvedValueOnce(mockVin);
      databaseService.vehicleVerification.update.mockResolvedValueOnce(succeededRecord());

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        }),
      ).resolves.toMatchObject(succeededResponse);
    });

    it("rejects a plate lookup that returns a different plate number", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce({
        ...mockPlate,
        plateNumber: "ABC-999ZZ",
      });
      premblyService.verifyVin.mockResolvedValueOnce(mockVin);

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        }),
      ).rejects.toBeInstanceOf(VehicleMismatchException);
    });

    it("maps Prembly plate UNAVAILABLE and marks the request failed", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockRejectedValueOnce(new PremblyError("UNAVAILABLE"));
      premblyService.verifyVin.mockResolvedValueOnce(mockVin);

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        }),
      ).rejects.toBeInstanceOf(ProviderVerificationException);

      expect(databaseService.vehicleVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.PROVIDER_UNAVAILABLE,
        },
      });
    });

    it("maps an NHTSA fallback failure", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce(mockPlate);
      premblyService.verifyVin.mockRejectedValueOnce(new PremblyError("UNAVAILABLE"));
      nhtsaService.verifyVin.mockRejectedValueOnce(new NhtsaError("REJECTED"));

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        }),
      ).rejects.toBeInstanceOf(ProviderVerificationException);

      expect(databaseService.vehicleVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.PROVIDER_REJECTED,
        },
      });
    });

    it("replays a succeeded request without calling providers again", async () => {
      databaseService.vehicleVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.vehicleVerification.findUnique.mockResolvedValueOnce(succeededRecord());

      const result = await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: PLATE,
        chassisNumber: CHASSIS,
      });

      expect(result).toMatchObject(succeededResponse);
      expect(result).not.toHaveProperty("insurance");
      expect(premblyService.verifyPlate).not.toHaveBeenCalled();
      expect(premblyService.verifyVin).not.toHaveBeenCalled();
      expect(nhtsaService.verifyVin).not.toHaveBeenCalled();
    });

    it("conflicts when the same idempotency key is reused with a different chassis", async () => {
      databaseService.vehicleVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.vehicleVerification.findUnique.mockResolvedValueOnce(succeededRecord());

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: "1HGCM82633A999999",
        }),
      ).rejects.toBeInstanceOf(VerificationIdempotencyKeyReusedException);
      expect(premblyService.verifyPlate).not.toHaveBeenCalled();
    });

    it("conflicts when the same idempotency key is reused with a different plate", async () => {
      databaseService.vehicleVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.vehicleVerification.findUnique.mockResolvedValueOnce(succeededRecord());

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: "ABC-999ZZ",
          chassisNumber: CHASSIS,
        }),
      ).rejects.toBeInstanceOf(VerificationIdempotencyKeyReusedException);
    });

    it("marks a vehicle older than 15 years as ineligible after a successful provider lookup", async () => {
      const tooOld = minimumVehicleYear() - 1;
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyPlate.mockResolvedValueOnce(mockPlate);
      premblyService.verifyVin.mockResolvedValueOnce({ ...mockVin, year: tooOld });
      databaseService.vehicleVerification.update.mockResolvedValueOnce(
        succeededRecord({ year: tooOld }),
      );

      const result = await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: PLATE,
        chassisNumber: CHASSIS,
      });

      expect(result.eligibility).toEqual({
        isEligible: false,
        reasons: ["VEHICLE_YEAR_BELOW_MINIMUM"],
        minimumYear: minimumVehicleYear(),
      });
    });

    it("replays a failed request with the stored failure reason", async () => {
      databaseService.vehicleVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.vehicleVerification.findUnique.mockResolvedValueOnce(
        processingRecord({
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.VEHICLE_MISMATCH,
        }),
      );

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        }),
      ).rejects.toBeInstanceOf(VehicleMismatchException);
      expect(premblyService.verifyPlate).not.toHaveBeenCalled();
    });

    it("retries a PROVIDER_UNAVAILABLE failure with the same key", async () => {
      databaseService.vehicleVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.vehicleVerification.findUnique.mockResolvedValueOnce(
        processingRecord({
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.PROVIDER_UNAVAILABLE,
        }),
      );
      databaseService.vehicleVerification.update
        .mockResolvedValueOnce(processingRecord())
        .mockResolvedValueOnce(succeededRecord());
      premblyService.verifyPlate.mockResolvedValueOnce(mockPlate);
      premblyService.verifyVin.mockResolvedValueOnce(mockVin);

      const result = await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: PLATE,
        chassisNumber: CHASSIS,
      });

      expect(databaseService.vehicleVerification.update).toHaveBeenNthCalledWith(1, {
        where: { id: VERIFICATION_ID },
        data: {
          status: ProviderVerificationStatus.PROCESSING,
          failureReason: null,
        },
      });
      expect(premblyService.verifyPlate).toHaveBeenCalledWith(NORMALIZED_PLATE);
      expect(premblyService.verifyVin).toHaveBeenCalledWith(CHASSIS);
      expect(result).toMatchObject(succeededResponse);
    });

    it("conflicts when an identical request is still processing", async () => {
      databaseService.vehicleVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.vehicleVerification.findUnique.mockResolvedValueOnce(processingRecord());

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          chassisNumber: CHASSIS,
        }),
      ).rejects.toBeInstanceOf(VerificationRequestInProgressException);
    });
  });

  describe("getVehicleVerification and createDraftCar", () => {
    it("returns an owned verification without an insurance field", async () => {
      databaseService.vehicleVerification.findFirst.mockResolvedValueOnce(succeededRecord());

      const result = await service.getVehicleVerification(OWNER_ID, VERIFICATION_ID);

      expect(result).toMatchObject(succeededResponse);
      expect(result).not.toHaveProperty("insurance");
      expect(result).not.toHaveProperty("policyNumber");
    });

    it("hides another owner's verification", async () => {
      databaseService.vehicleVerification.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.getVehicleVerification(OTHER_OWNER_ID, VERIFICATION_ID),
      ).rejects.toBeInstanceOf(VehicleVerificationNotFoundException);
    });

    it("replays a failed verification instead of creating a car", async () => {
      databaseService.vehicleVerification.findFirst.mockResolvedValueOnce(
        processingRecord({
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.PROVIDER_REJECTED,
        }),
      );

      await expect(service.createDraftCar(OWNER_ID, VERIFICATION_ID)).rejects.toBeInstanceOf(
        ProviderVerificationException,
      );
      expect(carService.createDraftCarFromVerification).not.toHaveBeenCalled();
    });

    it("refuses to create a draft car from an expired verification", async () => {
      databaseService.vehicleVerification.findFirst.mockResolvedValueOnce(
        succeededRecord({ expiresAt: pastExpiry() }),
      );

      await expect(service.createDraftCar(OWNER_ID, VERIFICATION_ID)).rejects.toBeInstanceOf(
        VehicleVerificationExpiredException,
      );
      expect(carService.createDraftCarFromVerification).not.toHaveBeenCalled();
    });

    it("consumes a verification only once", async () => {
      databaseService.vehicleVerification.findFirst.mockResolvedValueOnce(
        succeededRecord({ carId: "car-1" }),
      );

      await expect(service.createDraftCar(OWNER_ID, VERIFICATION_ID)).rejects.toBeInstanceOf(
        VehicleVerificationAlreadyUsedException,
      );
      expect(carService.createDraftCarFromVerification).not.toHaveBeenCalled();
    });

    it("blocks draft creation for a vehicle older than 15 years", async () => {
      databaseService.vehicleVerification.findFirst.mockResolvedValueOnce(
        succeededRecord({ year: minimumVehicleYear() - 1 }),
      );

      await expect(service.createDraftCar(OWNER_ID, VERIFICATION_ID)).rejects.toBeInstanceOf(
        VehicleNotEligibleException,
      );
      expect(carService.createDraftCarFromVerification).not.toHaveBeenCalled();
    });

    it("creates a draft car from an owned, eligible, unused verification", async () => {
      databaseService.vehicleVerification.findFirst.mockResolvedValueOnce(succeededRecord());
      carService.createDraftCarFromVerification.mockResolvedValueOnce({ id: "car-1" });

      await expect(service.createDraftCar(OWNER_ID, VERIFICATION_ID)).resolves.toEqual({
        id: "car-1",
      });
      expect(carService.createDraftCarFromVerification).toHaveBeenCalledWith(
        OWNER_ID,
        VERIFICATION_ID,
      );
    });

    it("rejects a still-processing verification instead of creating a car", async () => {
      databaseService.vehicleVerification.findFirst.mockResolvedValueOnce(processingRecord());

      await expect(service.createDraftCar(OWNER_ID, VERIFICATION_ID)).rejects.toBeInstanceOf(
        VerificationRequestInProgressException,
      );
    });
  });

  describe("createInsuranceVerification", () => {
    const car = {
      id: "car-1",
      registrationNumber: NORMALIZED_PLATE,
      chassisNumber: CHASSIS,
    };
    const policyNumber = "POL-123";
    const insuranceKey = "ins-key-1";
    const insuranceHash = hash({ carId: "car-1", policyNumber });

    const insuranceRecord = (overrides: Record<string, unknown> = {}) => ({
      id: "ins-1",
      carId: "car-1",
      ownerId: OWNER_ID,
      idempotencyKey: insuranceKey,
      requestHash: insuranceHash,
      policyNumber,
      policyStatus: "Active",
      policyExpiresAt: futureExpiry(),
      providerRef: "ins-ref",
      status: ProviderVerificationStatus.SUCCEEDED,
      createdAt: new Date("2026-09-07T12:00:00.000Z"),
      ...overrides,
    });

    it("accepts an active policy that matches the vehicle plate", async () => {
      const expiresAt = futureExpiry();
      databaseService.car.findFirst.mockResolvedValueOnce(car);
      databaseService.insuranceVerification.create.mockResolvedValueOnce(
        insuranceRecord({ status: ProviderVerificationStatus.PROCESSING, policyStatus: null }),
      );
      premblyService.verifyInsurance.mockResolvedValueOnce({
        policyNumber,
        policyStatus: "Active",
        plateNumbers: ["KJA-123AB"],
        chassisNumber: null,
        expiresAt,
        reference: "ins-ref",
      });
      databaseService.insuranceVerification.update.mockResolvedValueOnce(
        insuranceRecord({ policyExpiresAt: expiresAt }),
      );

      const result = await service.createInsuranceVerification({
        ownerId: OWNER_ID,
        carId: "car-1",
        idempotencyKey: insuranceKey,
        input: {
          policyNumber,
        },
      });

      expect(databaseService.insuranceVerification.update).toHaveBeenCalledWith({
        where: { id: "ins-1" },
        data: {
          status: ProviderVerificationStatus.SUCCEEDED,
          policyNumber,
          policyStatus: "Active",
          policyExpiresAt: expiresAt,
          providerRef: "ins-ref",
        },
      });
      expect(result).toMatchObject({
        id: "ins-1",
        carId: "car-1",
        status: ProviderVerificationStatus.SUCCEEDED,
        policyNumber,
        policyStatus: "Active",
        policyExpiresAt: expiresAt,
        providerRef: "ins-ref",
      });
    });

    it("accepts an active policy that matches chassis when plates differ", async () => {
      databaseService.car.findFirst.mockResolvedValueOnce(car);
      databaseService.insuranceVerification.create.mockResolvedValueOnce(
        insuranceRecord({ status: ProviderVerificationStatus.PROCESSING }),
      );
      premblyService.verifyInsurance.mockResolvedValueOnce({
        policyNumber,
        policyStatus: "active",
        plateNumbers: ["ABC999ZZ"],
        chassisNumber: CHASSIS,
        expiresAt: futureExpiry(),
        reference: "ins-ref",
      });
      databaseService.insuranceVerification.update.mockResolvedValueOnce(insuranceRecord());

      await expect(
        service.createInsuranceVerification({
          ownerId: OWNER_ID,
          carId: "car-1",
          idempotencyKey: insuranceKey,
          input: { policyNumber },
        }),
      ).resolves.toMatchObject({ status: ProviderVerificationStatus.SUCCEEDED });
    });

    it("rejects an inactive policy", async () => {
      databaseService.car.findFirst.mockResolvedValueOnce(car);
      databaseService.insuranceVerification.create.mockResolvedValueOnce(
        insuranceRecord({ status: ProviderVerificationStatus.PROCESSING }),
      );
      premblyService.verifyInsurance.mockResolvedValueOnce({
        policyNumber,
        policyStatus: "Expired",
        plateNumbers: [NORMALIZED_PLATE],
        chassisNumber: CHASSIS,
        expiresAt: futureExpiry(),
        reference: "ins-ref",
      });

      await expect(
        service.createInsuranceVerification({
          ownerId: OWNER_ID,
          carId: "car-1",
          idempotencyKey: insuranceKey,
          input: { policyNumber },
        }),
      ).rejects.toBeInstanceOf(InsuranceInactiveException);
      expect(databaseService.insuranceVerification.updateMany).toHaveBeenCalledWith({
        where: { id: "ins-1", status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.INSURANCE_INACTIVE,
        },
      });
    });

    it("rejects an active but expired policy", async () => {
      databaseService.car.findFirst.mockResolvedValueOnce(car);
      databaseService.insuranceVerification.create.mockResolvedValueOnce(
        insuranceRecord({ status: ProviderVerificationStatus.PROCESSING }),
      );
      premblyService.verifyInsurance.mockResolvedValueOnce({
        policyNumber,
        policyStatus: "Active",
        plateNumbers: [NORMALIZED_PLATE],
        chassisNumber: CHASSIS,
        expiresAt: pastExpiry(),
        reference: "ins-ref",
      });

      await expect(
        service.createInsuranceVerification({
          ownerId: OWNER_ID,
          carId: "car-1",
          idempotencyKey: insuranceKey,
          input: { policyNumber },
        }),
      ).rejects.toBeInstanceOf(InsuranceInactiveException);
    });

    it("replays a succeeded insurance request without calling Prembly again", async () => {
      databaseService.car.findFirst.mockResolvedValueOnce(car);
      databaseService.insuranceVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.insuranceVerification.findUnique.mockResolvedValueOnce(insuranceRecord());

      const result = await service.createInsuranceVerification({
        ownerId: OWNER_ID,
        carId: "car-1",
        idempotencyKey: insuranceKey,
        input: {
          policyNumber,
        },
      });

      expect(result.id).toBe("ins-1");
      expect(premblyService.verifyInsurance).not.toHaveBeenCalled();
    });

    it("conflicts when the same insurance idempotency key is reused with a different policy", async () => {
      databaseService.car.findFirst.mockResolvedValueOnce(car);
      databaseService.insuranceVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.insuranceVerification.findUnique.mockResolvedValueOnce(insuranceRecord());

      await expect(
        service.createInsuranceVerification({
          ownerId: OWNER_ID,
          carId: "car-1",
          idempotencyKey: insuranceKey,
          input: {
            policyNumber: "OTHER-POL",
          },
        }),
      ).rejects.toBeInstanceOf(VerificationIdempotencyKeyReusedException);
    });

    it("rejects an active policy that matches neither plate nor chassis", async () => {
      databaseService.car.findFirst.mockResolvedValueOnce(car);
      databaseService.insuranceVerification.create.mockResolvedValueOnce(
        insuranceRecord({ status: ProviderVerificationStatus.PROCESSING }),
      );
      premblyService.verifyInsurance.mockResolvedValueOnce({
        policyNumber,
        policyStatus: "Active",
        plateNumbers: ["ABC999ZZ"],
        chassisNumber: "1HGCM82633A999999",
        expiresAt: futureExpiry(),
        reference: "ins-ref",
      });

      await expect(
        service.createInsuranceVerification({
          ownerId: OWNER_ID,
          carId: "car-1",
          idempotencyKey: insuranceKey,
          input: { policyNumber },
        }),
      ).rejects.toBeInstanceOf(InsuranceVehicleMismatchException);
    });

    it("throws when the car does not belong to the owner", async () => {
      databaseService.car.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.createInsuranceVerification({
          ownerId: OWNER_ID,
          carId: "car-1",
          idempotencyKey: insuranceKey,
          input: { policyNumber },
        }),
      ).rejects.toBeInstanceOf(CarNotFoundException);
      expect(premblyService.verifyInsurance).not.toHaveBeenCalled();
    });
  });
});
