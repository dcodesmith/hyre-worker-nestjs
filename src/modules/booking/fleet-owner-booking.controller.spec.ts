import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FLEET_OWNER } from "../auth/auth.const";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { VerifiedFleetOwnerGuard } from "../auth/guards/verified-fleet-owner.guard";
import { BookingUpdateService } from "./booking-update.service";
import { FleetOwnerBookingController } from "./fleet-owner-booking.controller";
import { FleetOwnerBookingReadService } from "./fleet-owner-booking-read.service";

describe("FleetOwnerBookingController", () => {
  const sessionUser = { id: "owner-1" } as AuthSession["user"];
  const bookingReadService = {
    list: vi.fn(),
    get: vi.fn(),
  };
  const bookingUpdateService = {
    assignChauffeur: vi.fn(),
  };

  let controller: FleetOwnerBookingController;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FleetOwnerBookingController],
      providers: [
        { provide: FleetOwnerBookingReadService, useValue: bookingReadService },
        { provide: BookingUpdateService, useValue: bookingUpdateService },
      ],
    })
      .overrideGuard(SessionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RoleGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(VerifiedFleetOwnerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(FleetOwnerBookingController);
  });

  it("requires a verified fleet-owner session", () => {
    expect(Reflect.getMetadata(PATH_METADATA, FleetOwnerBookingController)).toBe(
      "api/fleet-owner/bookings",
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, FleetOwnerBookingController)).toEqual([
      SessionGuard,
      RoleGuard,
      VerifiedFleetOwnerGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, FleetOwnerBookingController)).toEqual([FLEET_OWNER]);
  });

  it("exposes list, detail, and chauffeur assignment routes", () => {
    const { list, get, assignChauffeur } = FleetOwnerBookingController.prototype;

    expect(Reflect.getMetadata(PATH_METADATA, list)).toBe("/");
    expect(Reflect.getMetadata(METHOD_METADATA, list)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, get)).toBe(":bookingId");
    expect(Reflect.getMetadata(METHOD_METADATA, get)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, assignChauffeur)).toBe(":bookingId/chauffeur");
    expect(Reflect.getMetadata(METHOD_METADATA, assignChauffeur)).toBe(RequestMethod.PATCH);
  });

  it("reads bookings for the signed-in owner", async () => {
    const listResult = { items: [], meta: { page: 2, limit: 10, total: 0, totalPages: 0 } };
    const detailResult = { booking: { id: "booking-1" }, assignableChauffeurs: [] };
    bookingReadService.list.mockResolvedValueOnce(listResult);
    bookingReadService.get.mockResolvedValueOnce(detailResult);

    await expect(controller.list({ page: 2, limit: 10 }, sessionUser)).resolves.toEqual(listResult);
    await expect(controller.get("booking-1", sessionUser)).resolves.toEqual(detailResult);

    expect(bookingReadService.list).toHaveBeenCalledWith("owner-1", { page: 2, limit: 10 });
    expect(bookingReadService.get).toHaveBeenCalledWith("owner-1", "booking-1");
  });

  it("assigns a chauffeur for the signed-in owner", async () => {
    const assignment = { id: "booking-1", chauffeurId: "chauffeur-1" };
    bookingUpdateService.assignChauffeur.mockResolvedValueOnce(assignment);

    await expect(
      controller.assignChauffeur("booking-1", { chauffeurId: "chauffeur-1" }, sessionUser),
    ).resolves.toEqual(assignment);
    expect(bookingUpdateService.assignChauffeur).toHaveBeenCalledWith(
      "booking-1",
      "owner-1",
      "chauffeur-1",
    );
  });
});
