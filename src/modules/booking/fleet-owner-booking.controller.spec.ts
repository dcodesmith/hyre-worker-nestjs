import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { AuthService } from "../auth/auth.service";
import { BookingUpdateService } from "./booking-update.service";
import { FleetOwnerBookingController } from "./fleet-owner-booking.controller";

describe("FleetOwnerBookingController", () => {
  let controller: FleetOwnerBookingController;
  let bookingUpdateService: BookingUpdateService;

  const mockFleetOwner = {
    id: "owner-1",
    email: "owner@example.com",
    name: "Fleet Owner",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: ["fleetOwner" as const],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FleetOwnerBookingController],
      providers: [
        {
          provide: BookingUpdateService,
          useValue: {
            assignChauffeur: vi.fn(),
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

    controller = module.get<FleetOwnerBookingController>(FleetOwnerBookingController);
    bookingUpdateService = module.get<BookingUpdateService>(BookingUpdateService);
  });

  it("assigns a chauffeur to a booking for fleet owner", async () => {
    vi.mocked(bookingUpdateService.assignChauffeur).mockResolvedValueOnce({
      id: "booking-1",
      chauffeurId: "chauffeur-1",
    } as never);

    const result = await controller.assignChauffeur(
      "booking-1",
      { chauffeurId: "chauffeur-1" },
      mockFleetOwner,
    );

    expect(result).toEqual({ id: "booking-1", chauffeurId: "chauffeur-1" });
    expect(bookingUpdateService.assignChauffeur).toHaveBeenCalledWith(
      "booking-1",
      "owner-1",
      "chauffeur-1",
    );
  });
});
