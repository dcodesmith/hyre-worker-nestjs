import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { ServiceTier, VehicleType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth/auth.service";
import { CarController } from "./car.controller";
import type { CarCreateFiles } from "./car.interface";
import { CarService } from "./car.service";
import type { CreateCarMultipartBodyDto } from "./dto/create-car.dto";

describe("CarController", () => {
  let controller: CarController;
  let carService: CarService;

  const mockUser = {
    id: "owner-1",
    name: "Fleet Owner",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: ["fleetOwner" as const],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CarController],
      providers: [
        {
          provide: CarService,
          useValue: {
            listOwnerCars: vi.fn(),
            getOwnerCarById: vi.fn(),
            createCar: vi.fn(),
            updateCar: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            isInitialized: true,
            auth: {
              api: {
                getSession: vi.fn().mockResolvedValue(null),
              },
            },
            getUserRoles: vi.fn().mockResolvedValue(["fleetOwner"]),
          },
        },
        Reflector,
      ],
    }).compile();

    controller = module.get<CarController>(CarController);
    carService = module.get<CarService>(CarService);
  });

  it("lists owner cars", async () => {
    vi.mocked(carService.listOwnerCars).mockResolvedValueOnce([{ id: "car-1" }] as never);

    const result = await controller.listOwnerCars(mockUser);

    expect(result).toEqual([{ id: "car-1" }]);
    expect(carService.listOwnerCars).toHaveBeenCalledWith("owner-1");
  });

  it("returns owner car detail", async () => {
    vi.mocked(carService.getOwnerCarById).mockResolvedValueOnce({ id: "car-1" } as never);

    const result = await controller.getOwnerCarById("car-1", mockUser);

    expect(result).toEqual({ id: "car-1" });
    expect(carService.getOwnerCarById).toHaveBeenCalledWith("car-1", "owner-1");
  });

  it("creates a car for authenticated fleet owner", async () => {
    const body: CreateCarMultipartBodyDto = {
      make: "Toyota",
      model: "Camry",
      year: 2022,
      color: "",
      registrationNumber: "ABC-123XY",
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
    };
    const files: CarCreateFiles = {
      images: [
        {
          originalname: "car-1.jpg",
          mimetype: "image/jpeg",
          buffer: Buffer.from("image"),
          size: 5,
        },
      ],
      motCertificate: {
        originalname: "mot.pdf",
        mimetype: "application/pdf",
        buffer: Buffer.from("pdf"),
        size: 3,
      },
      insuranceCertificate: {
        originalname: "insurance.pdf",
        mimetype: "application/pdf",
        buffer: Buffer.from("pdf"),
        size: 3,
      },
    };

    vi.mocked(carService.createCar).mockResolvedValueOnce({ id: "car-1" } as never);

    const result = await controller.createCar(body, files, mockUser);

    expect(result).toEqual({ id: "car-1" });
    expect(carService.createCar).toHaveBeenCalledWith("owner-1", body, files);
  });

  it("updates owner car", async () => {
    vi.mocked(carService.updateCar).mockResolvedValueOnce({ id: "car-1", status: "HOLD" } as never);

    const result = await controller.updateCar("car-1", { status: "HOLD" }, mockUser);

    expect(result).toEqual({ id: "car-1", status: "HOLD" });
    expect(carService.updateCar).toHaveBeenCalledWith("car-1", "owner-1", { status: "HOLD" });
  });
});
