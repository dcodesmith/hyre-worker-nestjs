import { GoneException, HttpStatus } from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { AuthService } from "../auth/auth.service";
import { VerifiedFleetOwnerGuard } from "../auth/guards/verified-fleet-owner.guard";
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
            uploadDraftCarDocuments: vi.fn(),
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
      .overrideGuard(VerifiedFleetOwnerGuard)
      .useValue({ canActivate: vi.fn().mockResolvedValue(true) })
      .useMocker(mockPinoLoggerToken)
      .compile();

    controller = module.get<FleetOwnerCarController>(FleetOwnerCarController);
    carService = module.get<CarService>(CarService);
  });

  describe("createCar", () => {
    it("requires the verified onboarding flow", () => {
      expect(() => controller.createCar()).toThrow(GoneException);
      expect(() => controller.createCar()).toThrow(/vehicle-verifications/);
    });
  });

  describe("staged onboarding", () => {
    it("uploads draft documents", async () => {
      const files = {
        vehicleRegistration: {},
        motCertificate: {},
        insuranceCertificate: {},
      };
      vi.mocked(carService.uploadDraftCarDocuments).mockResolvedValueOnce({ id: "car-1" } as never);

      await expect(
        controller.uploadDraftCarDocuments("car-1", files as never, mockUser),
      ).resolves.toEqual({ id: "car-1" });
      expect(carService.uploadDraftCarDocuments).toHaveBeenCalledWith("car-1", "owner-1", files);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.uploadDraftCarDocuments)).toBe(
        HttpStatus.CREATED,
      );
    });
  });
});
