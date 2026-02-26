import { Test, type TestingModule } from "@nestjs/testing";
import { ServiceTier, Status, VehicleType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { StorageService } from "../storage/storage.service";
import {
  CarCreateFailedException,
  CarFetchFailedException,
  CarNotFoundException,
  OwnerDriverCarLimitReachedException,
  RegistrationNumberAlreadyExistsException,
} from "./car.error";
import { CarService } from "./car.service";

describe("CarService", () => {
  let service: CarService;
  const createMockFile = (name: string, mimetype: string, content = "file") => ({
    fieldname: "file",
    originalname: name,
    encoding: "7bit",
    mimetype,
    buffer: Buffer.from(content),
    size: Buffer.byteLength(content),
  });
  const createCarDto = (registrationNumber = "ABC-123XY") => ({
    make: "Toyota",
    model: "Camry",
    year: 2022,
    color: "",
    registrationNumber,
    dayRate: 50000,
    hourlyRate: 5000,
    nightRate: 60000,
    fullDayRate: 100000,
    airportPickupRate: 30000,
    pricingIncludesFuel: false,
    fuelUpgradeRate: 10000,
    vehicleType: VehicleType.SEDAN,
    serviceTier: ServiceTier.STANDARD,
    passengerCapacity: 4,
  });
  const createCarFiles = () => ({
    images: [createMockFile("car.jpg", "image/jpeg")],
    motCertificate: createMockFile("mot.pdf", "application/pdf"),
    insuranceCertificate: createMockFile("insurance.pdf", "application/pdf"),
  });

  const databaseServiceMock = {
    car: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    vehicleImage: {
      createMany: vi.fn(),
    },
    documentApproval: {
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const storageServiceMock = {
    uploadBuffer: vi.fn(),
    deleteObjectByKey: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CarService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: StorageService, useValue: storageServiceMock },
      ],
    }).compile();

    service = module.get<CarService>(CarService);
  });

  it("lists owner cars ordered by latest updates", async () => {
    databaseServiceMock.car.findMany.mockResolvedValueOnce([{ id: "car-1" }, { id: "car-2" }]);

    const result = await service.listOwnerCars("owner-1");

    expect(result).toEqual([{ id: "car-1" }, { id: "car-2" }]);
    expect(databaseServiceMock.car.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: "owner-1" }, orderBy: { updatedAt: "desc" } }),
    );
  });

  it("returns owner car detail", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce({ id: "car-1", ownerId: "owner-1" });

    const result = await service.getOwnerCarById("car-1", "owner-1");

    expect(result).toEqual({ id: "car-1", ownerId: "owner-1" });
  });

  it("throws CarNotFoundException for unknown owner car", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce(null);

    await expect(service.getOwnerCarById("missing", "owner-1")).rejects.toBeInstanceOf(
      CarNotFoundException,
    );
  });

  it("enforces owner-driver single-car limit during create", async () => {
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: true });
    databaseServiceMock.car.count.mockResolvedValueOnce(1);

    await expect(
      service.createCar("owner-1", createCarDto(), createCarFiles()),
    ).rejects.toBeInstanceOf(OwnerDriverCarLimitReachedException);
  });

  it("rejects duplicate registration number for same owner (format-insensitive)", async () => {
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: false });
    databaseServiceMock.car.findMany.mockResolvedValueOnce([{ registrationNumber: "ABC123XY" }]);

    await expect(
      service.createCar("owner-1", createCarDto("ABC-123XY"), createCarFiles()),
    ).rejects.toBeInstanceOf(RegistrationNumberAlreadyExistsException);
  });

  it("creates car and related images/documents in transaction", async () => {
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: false });
    databaseServiceMock.car.findMany.mockResolvedValueOnce([]);
    databaseServiceMock.car.create.mockResolvedValueOnce({ id: "car-1" });
    storageServiceMock.uploadBuffer
      .mockResolvedValueOnce("https://cdn.example.com/car-1.jpg")
      .mockResolvedValueOnce("https://cdn.example.com/mot.pdf")
      .mockResolvedValueOnce("https://cdn.example.com/insurance.pdf");
    databaseServiceMock.$transaction.mockImplementationOnce(async (callback) =>
      callback({
        car: { findUnique: vi.fn().mockResolvedValue({ id: "car-1", ownerId: "owner-1" }) },
        vehicleImage: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
        documentApproval: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      }),
    );

    const result = await service.createCar("owner-1", createCarDto("ABC-123XY"), createCarFiles());

    expect(result).toEqual({ id: "car-1", ownerId: "owner-1" });
    expect(databaseServiceMock.car.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          registrationNumber: "ABC123XY",
        }),
      }),
    );
  });

  it("updates owner car", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce({
      id: "car-1",
      registrationNumber: "ABC-123XY",
    });
    databaseServiceMock.car.update.mockResolvedValueOnce({
      id: "car-1",
      status: Status.HOLD,
    });

    const result = await service.updateCar("car-1", "owner-1", { status: Status.HOLD });

    expect(result).toEqual({ id: "car-1", status: Status.HOLD });
  });

  it("rejects update when registration number conflicts after normalization", async () => {
    databaseServiceMock.car.findFirst.mockResolvedValueOnce({
      id: "car-1",
      registrationNumber: "ZZZ-999AA",
    });
    databaseServiceMock.car.findMany.mockResolvedValueOnce([{ registrationNumber: "ABC123XY" }]);

    await expect(
      service.updateCar("car-1", "owner-1", { registrationNumber: "ABC 123XY" }),
    ).rejects.toBeInstanceOf(RegistrationNumberAlreadyExistsException);
  });

  it("deletes already-uploaded files when create fails mid-upload", async () => {
    databaseServiceMock.user.findUnique.mockResolvedValueOnce({ isOwnerDriver: false });
    databaseServiceMock.car.findMany.mockResolvedValueOnce([]);
    databaseServiceMock.car.create.mockResolvedValueOnce({ id: "car-1" });
    databaseServiceMock.car.delete.mockResolvedValueOnce({ id: "car-1" });
    storageServiceMock.uploadBuffer
      .mockResolvedValueOnce("https://cdn.example.com/car-1.jpg")
      .mockRejectedValueOnce(new Error("s3 timeout"));
    storageServiceMock.deleteObjectByKey.mockResolvedValue(undefined);

    await expect(
      service.createCar("owner-1", createCarDto(), createCarFiles()),
    ).rejects.toBeInstanceOf(CarCreateFailedException);

    expect(databaseServiceMock.car.delete).toHaveBeenCalledWith({ where: { id: "car-1" } });
    expect(storageServiceMock.deleteObjectByKey.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(
      storageServiceMock.deleteObjectByKey.mock.calls.some(([key]) =>
        typeof key === "string" ? key.includes("owner-1/car-1/") : false,
      ),
    ).toBe(true);
  });

  it("throws CarFetchFailedException when list query fails unexpectedly", async () => {
    databaseServiceMock.car.findMany.mockRejectedValueOnce(new Error("db down"));

    await expect(service.listOwnerCars("owner-1")).rejects.toBeInstanceOf(CarFetchFailedException);
  });
});
