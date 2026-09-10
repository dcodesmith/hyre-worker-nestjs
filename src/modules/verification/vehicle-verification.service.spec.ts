import { createHash } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { Prisma, ProviderVerificationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { CarNotFoundException } from "../car/car.error";
import { CarService } from "../car/car.service";
import { DatabaseService } from "../database/database.service";
import { PremblyError, PremblyService } from "../prembly/prembly.service";
import {
  createInsuranceVerificationSchema,
  createVehicleVerificationSchema,
} from "./vehicle-verification.dto";
import { VehicleVerificationService } from "./vehicle-verification.service";
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
const POLICY_STATUS = "Active";
const POLICY_EXPIRES_AT = new Date("2027-01-14T22:59:59.999Z");

const uniqueConstraintError = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });

const hash = (value: Record<string, string>) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const requestHash = hash({ plateNumber: NORMALIZED_PLATE, policyNumber: POLICY_NUMBER });

const futureExpiry = () => new Date(Date.now() + 60 * 60 * 1000);
const pastExpiry = () => new Date(Date.now() - 60 * 1000);

const processingRecord = (overrides: Record<string, unknown> = {}) => ({
  id: VERIFICATION_ID,
  ownerId: OWNER_ID,
  idempotencyKey: IDEMPOTENCY_KEY,
  requestHash,
  plateNumber: NORMALIZED_PLATE,
  chassisNumber: null,
  make: null,
  model: null,
  year: null,
  color: null,
  passengerCapacity: null,
  status: ProviderVerificationStatus.PROCESSING,
  failureReason: null,
  expiresAt: futureExpiry(),
  carId: null,
  insurancePolicyNumber: POLICY_NUMBER,
  insurancePolicyStatus: null,
  insurancePolicyExpiresAt: null,
  insuranceProviderRef: null,
  ...overrides,
});

const succeededRecord = (overrides: Record<string, unknown> = {}) =>
  processingRecord({
    status: ProviderVerificationStatus.SUCCEEDED,
    chassisNumber: CHASSIS,
    make: "Toyota",
    model: "Camry",
    year: 2020,
    color: "Black",
    passengerCapacity: 5,
    vinProviderRef: "vin-ref",
    insurancePolicyNumber: POLICY_NUMBER,
    insurancePolicyStatus: POLICY_STATUS,
    insurancePolicyExpiresAt: POLICY_EXPIRES_AT,
    insuranceProviderRef: "ins-ref",
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
  eligibility: { isEligible: true, reasons: [] },
  carId: null,
};

describe("createVehicleVerificationSchema", () => {
  it("accepts plate and policy and trims the policy number", () => {
    const parsed = createVehicleVerificationSchema.safeParse({
      plateNumber: "kja-123ab",
      policyNumber: "  test/policy/123  ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        plateNumber: "KJA-123AB",
        policyNumber: "test/policy/123",
      });
    }
  });

  it.each([
    [{ plateNumber: PLATE }, "policyNumber"],
    [{ policyNumber: POLICY_NUMBER }, "plateNumber"],
    [{ plateNumber: "not-a-plate", policyNumber: POLICY_NUMBER }, "plateNumber"],
    [{ plateNumber: PLATE, policyNumber: "ab" }, "policyNumber"],
    [{ plateNumber: PLATE, policyNumber: "x".repeat(101) }, "policyNumber"],
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
  let carService: { createDraftCarFromVerification: ReturnType<typeof vi.fn> };

  const mockInsurance = {
    policyNumber: POLICY_NUMBER,
    policyStatus: POLICY_STATUS,
    plateNumbers: [PLATE],
    chassisNumber: CHASSIS,
    color: "Black",
    expiresAt: POLICY_EXPIRES_AT,
    reference: "ins-ref",
  };
  const mockVin = {
    year: 2020,
    make: "Toyota",
    model: "Camry",
    passengerCapacity: 5,
    reference: "vin-ref",
  };

  const mockSuccessfulProviders = () => {
    premblyService.verifyInsurance.mockResolvedValueOnce(mockInsurance);
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
    carService = { createDraftCarFromVerification: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VehicleVerificationService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: PremblyService, useValue: premblyService },
        { provide: CarService, useValue: carService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(VehicleVerificationService);
  });

  describe("createVehicleVerification", () => {
    it("hashes plate and policy, verifies insurance then VIN, and persists the insurance snapshot", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      mockSuccessfulProviders();

      const result = await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: "kja-123 ab",
        policyNumber: "  test/policy/123  ",
      });

      expect(databaseService.vehicleVerification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ownerId: OWNER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          requestHash,
          plateNumber: NORMALIZED_PLATE,
          insurancePolicyNumber: POLICY_NUMBER,
        }),
      });
      expect(premblyService.verifyInsurance).toHaveBeenCalledWith(POLICY_NUMBER);
      expect(premblyService.verifyVin).toHaveBeenCalledWith(CHASSIS);
      expect(premblyService.verifyVin.mock.invocationCallOrder[0]).toBeGreaterThan(
        premblyService.verifyInsurance.mock.invocationCallOrder[0] ?? 0,
      );
      expect(premblyService.verifyPlate).not.toHaveBeenCalled();
      expect(databaseService.vehicleVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: {
          status: ProviderVerificationStatus.SUCCEEDED,
          chassisNumber: CHASSIS,
          make: "Toyota",
          model: "Camry",
          year: 2020,
          color: "Black",
          passengerCapacity: 5,
          vinProviderRef: "vin-ref",
          insurancePolicyNumber: POLICY_NUMBER,
          insurancePolicyStatus: POLICY_STATUS,
          insurancePolicyExpiresAt: POLICY_EXPIRES_AT,
          insuranceProviderRef: "ins-ref",
        },
      });
      expect(result).toMatchObject(succeededResponse);
      expect(result).not.toHaveProperty("insurance");
      expect(result).not.toHaveProperty("policyNumber");
      expect(result.vehicle.color).toBe("Black");
    });

    it("rejects an inactive policy and does not call Prembly VIN", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyInsurance.mockResolvedValueOnce({
        ...mockInsurance,
        policyStatus: "Expired",
      });

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          policyNumber: POLICY_NUMBER,
        }),
      ).rejects.toBeInstanceOf(InsuranceInactiveException);

      expect(databaseService.vehicleVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.INSURANCE_INACTIVE,
        },
      });
      expect(premblyService.verifyVin).not.toHaveBeenCalled();
    });

    it("rejects an active but expired policy and does not call Prembly VIN", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyInsurance.mockResolvedValueOnce({
        ...mockInsurance,
        expiresAt: pastExpiry(),
      });

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          policyNumber: POLICY_NUMBER,
        }),
      ).rejects.toBeInstanceOf(InsuranceInactiveException);
      expect(premblyService.verifyVin).not.toHaveBeenCalled();
    });

    it("rejects a policy whose plates do not include the requested plate", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyInsurance.mockResolvedValueOnce({
        ...mockInsurance,
        plateNumbers: ["ABC-999ZZ"],
      });

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          policyNumber: POLICY_NUMBER,
        }),
      ).rejects.toBeInstanceOf(InsuranceVehicleMismatchException);

      expect(databaseService.vehicleVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.INSURANCE_VEHICLE_MISMATCH,
        },
      });
      expect(premblyService.verifyVin).not.toHaveBeenCalled();
    });

    it("rejects a missing chassis and does not call Prembly VIN", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyInsurance.mockResolvedValueOnce({
        ...mockInsurance,
        chassisNumber: null,
      });

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          policyNumber: POLICY_NUMBER,
        }),
      ).rejects.toBeInstanceOf(ProviderVerificationException);

      expect(databaseService.vehicleVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.PROVIDER_INVALID_RESPONSE,
        },
      });
      expect(premblyService.verifyVin).not.toHaveBeenCalled();
    });

    it("maps an invalid chassis Prembly response and does not call VIN", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyInsurance.mockRejectedValueOnce(new PremblyError("INVALID_RESPONSE"));

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          policyNumber: POLICY_NUMBER,
        }),
      ).rejects.toBeInstanceOf(ProviderVerificationException);

      expect(databaseService.vehicleVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.PROVIDER_INVALID_RESPONSE,
        },
      });
      expect(premblyService.verifyVin).not.toHaveBeenCalled();
    });

    it("maps Prembly UNAVAILABLE and marks the request failed", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyInsurance.mockRejectedValueOnce(new PremblyError("UNAVAILABLE"));

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          policyNumber: POLICY_NUMBER,
        }),
      ).rejects.toBeInstanceOf(ProviderVerificationException);

      expect(databaseService.vehicleVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.PROVIDER_UNAVAILABLE,
        },
      });
      expect(premblyService.verifyVin).not.toHaveBeenCalled();
    });

    it("replays a succeeded request without calling Prembly again", async () => {
      databaseService.vehicleVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.vehicleVerification.findUnique.mockResolvedValueOnce(succeededRecord());

      const result = await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: PLATE,
        policyNumber: POLICY_NUMBER,
      });

      expect(result).toMatchObject(succeededResponse);
      expect(result).not.toHaveProperty("insurance");
      expect(premblyService.verifyInsurance).not.toHaveBeenCalled();
      expect(premblyService.verifyVin).not.toHaveBeenCalled();
      expect(premblyService.verifyPlate).not.toHaveBeenCalled();
    });

    it("conflicts when the same idempotency key is reused with a different policy", async () => {
      databaseService.vehicleVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.vehicleVerification.findUnique.mockResolvedValueOnce(succeededRecord());

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          policyNumber: "OTHER/POLICY/999",
        }),
      ).rejects.toBeInstanceOf(VerificationIdempotencyKeyReusedException);
      expect(premblyService.verifyInsurance).not.toHaveBeenCalled();
    });

    it("conflicts when the same idempotency key is reused with a different plate", async () => {
      databaseService.vehicleVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.vehicleVerification.findUnique.mockResolvedValueOnce(succeededRecord());

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: "ABC-999ZZ",
          policyNumber: POLICY_NUMBER,
        }),
      ).rejects.toBeInstanceOf(VerificationIdempotencyKeyReusedException);
      expect(premblyService.verifyInsurance).not.toHaveBeenCalled();
    });

    it("marks a vehicle under 2015 as ineligible after a successful provider lookup", async () => {
      databaseService.vehicleVerification.create.mockResolvedValueOnce(processingRecord());
      premblyService.verifyInsurance.mockResolvedValueOnce(mockInsurance);
      premblyService.verifyVin.mockResolvedValueOnce({ ...mockVin, year: 2014 });
      databaseService.vehicleVerification.update.mockResolvedValueOnce(
        succeededRecord({ year: 2014 }),
      );

      const result = await service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
        plateNumber: PLATE,
        policyNumber: POLICY_NUMBER,
      });

      expect(result.eligibility).toEqual({
        isEligible: false,
        reasons: ["VEHICLE_YEAR_BELOW_MINIMUM"],
      });
      expect(result).not.toHaveProperty("insurance");
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
          policyNumber: POLICY_NUMBER,
        }),
      ).rejects.toBeInstanceOf(VehicleMismatchException);
      expect(premblyService.verifyInsurance).not.toHaveBeenCalled();
    });

    it("replays a failed inactive-policy request as INSURANCE_INACTIVE", async () => {
      databaseService.vehicleVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.vehicleVerification.findUnique.mockResolvedValueOnce(
        processingRecord({
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.INSURANCE_INACTIVE,
        }),
      );

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          policyNumber: POLICY_NUMBER,
        }),
      ).rejects.toBeInstanceOf(InsuranceInactiveException);
      expect(premblyService.verifyInsurance).not.toHaveBeenCalled();
    });

    it("conflicts when an identical request is still processing", async () => {
      databaseService.vehicleVerification.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.vehicleVerification.findUnique.mockResolvedValueOnce(processingRecord());

      await expect(
        service.createVehicleVerification(OWNER_ID, IDEMPOTENCY_KEY, {
          plateNumber: PLATE,
          policyNumber: POLICY_NUMBER,
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

    it("blocks draft creation for an under-2015 vehicle", async () => {
      databaseService.vehicleVerification.findFirst.mockResolvedValueOnce(
        succeededRecord({ year: 2010 }),
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
      expect(databaseService.insuranceVerification.updateMany).toHaveBeenCalledWith({
        where: { id: "ins-1", status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.INSURANCE_INACTIVE,
        },
      });
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
