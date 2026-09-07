import { GoneException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { AuthService } from "../auth/auth.service";
import { CarService } from "./car.service";
import { FleetOwnerCarController } from "./fleet-owner-car.controller";

describe("FleetOwnerCarController", () => {
  let controller: FleetOwnerCarController;
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
      controllers: [FleetOwnerCarController],
      providers: [
        {
          provide: CarService,
          useValue: {
            listOwnerCars: vi.fn(),
            getOwnerCarById: vi.fn(),
            updateCar: vi.fn(),
            uploadDraftCarDocuments: vi.fn(),
            uploadDraftCarImages: vi.fn(),
            updateDraftCarPricing: vi.fn(),
            submitCar: vi.fn(),
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
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    controller = module.get<FleetOwnerCarController>(FleetOwnerCarController);
    carService = module.get<CarService>(CarService);
  });

  describe("listOwnerCars", () => {
    it("lists owner cars (GET /api/fleet-owner/cars)", async () => {
      vi.mocked(carService.listOwnerCars).mockResolvedValueOnce([{ id: "car-1" }] as never);

      const result = await controller.listOwnerCars(mockUser);

      expect(result).toEqual([{ id: "car-1" }]);
      expect(carService.listOwnerCars).toHaveBeenCalledWith("owner-1");
    });
  });

  describe("getOwnerCarById", () => {
    it("returns owner car detail (GET /api/fleet-owner/cars/:carId)", async () => {
      vi.mocked(carService.getOwnerCarById).mockResolvedValueOnce({ id: "car-1" } as never);

      const result = await controller.getOwnerCarById("car-1", mockUser);

      expect(result).toEqual({ id: "car-1" });
      expect(carService.getOwnerCarById).toHaveBeenCalledWith("car-1", "owner-1");
    });
  });

  describe("createCar", () => {
    it("requires the verified onboarding flow", () => {
      expect(() => controller.createCar()).toThrow(GoneException);
      expect(() => controller.createCar()).toThrow(/vehicle-verifications/);
    });
  });

  describe("staged onboarding", () => {
    it("uploads draft documents", async () => {
      const files = { motCertificate: {}, insuranceCertificate: {} };
      vi.mocked(carService.uploadDraftCarDocuments).mockResolvedValueOnce({ id: "car-1" } as never);

      await expect(
        controller.uploadDraftCarDocuments("car-1", files as never, mockUser),
      ).resolves.toEqual({ id: "car-1" });
      expect(carService.uploadDraftCarDocuments).toHaveBeenCalledWith("car-1", "owner-1", files);
    });

    it("uploads draft images", async () => {
      const images = [{ originalname: "a.jpg" }];
      vi.mocked(carService.uploadDraftCarImages).mockResolvedValueOnce({ id: "car-1" } as never);

      await expect(
        controller.uploadDraftCarImages("car-1", images as never, mockUser),
      ).resolves.toEqual({ id: "car-1" });
      expect(carService.uploadDraftCarImages).toHaveBeenCalledWith("car-1", "owner-1", images);
    });

    it("updates draft pricing", async () => {
      const pricing = { hourlyRate: 5000, pricingIncludesFuel: true };
      vi.mocked(carService.updateDraftCarPricing).mockResolvedValueOnce({ id: "car-1" } as never);

      await expect(
        controller.updateDraftCarPricing("car-1", pricing as never, mockUser),
      ).resolves.toEqual({ id: "car-1" });
      expect(carService.updateDraftCarPricing).toHaveBeenCalledWith("car-1", "owner-1", pricing);
    });

    it("submits a draft car", async () => {
      vi.mocked(carService.submitCar).mockResolvedValueOnce({ success: true } as never);

      await expect(controller.submitCar("car-1", mockUser)).resolves.toEqual({ success: true });
      expect(carService.submitCar).toHaveBeenCalledWith("car-1", "owner-1");
    });
  });

  describe("updateCar", () => {
    it("updates owner car (PATCH /api/fleet-owner/cars/:carId)", async () => {
      vi.mocked(carService.updateCar).mockResolvedValueOnce({
        id: "car-1",
        status: "HOLD",
      } as never);

      const result = await controller.updateCar("car-1", { status: "HOLD" }, mockUser);

      expect(result).toEqual({ id: "car-1", status: "HOLD" });
      expect(carService.updateCar).toHaveBeenCalledWith("car-1", "owner-1", { status: "HOLD" });
    });
  });
});
