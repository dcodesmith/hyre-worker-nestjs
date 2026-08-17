import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerGuard } from "@nestjs/throttler";
import { BookingCompletionSource } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN, FLEET_OWNER } from "../auth/auth.const";
import { RoleGuard } from "../auth/guards/role.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { hashBookingCompletionToken } from "../booking/booking-completion-token.helper";
import {
  AirportTripCompletionPageController,
  FleetOwnerAirportTripCompletionController,
} from "./airport-trip-completion.controller";
import { StatusChangeService } from "./status-change.service";

describe("airport trip completion controllers", () => {
  let pageController: AirportTripCompletionPageController;
  let fleetController: FleetOwnerAirportTripCompletionController;
  const statusChangeService = {
    getAirportCompletionDetails: vi.fn(),
    completeAirportBookingWithToken: vi.fn(),
    completeAirportBookingForUser: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AirportTripCompletionPageController, FleetOwnerAirportTripCompletionController],
      providers: [{ provide: StatusChangeService, useValue: statusChangeService }],
    })
      .overrideGuard(SessionGuard)
      .useValue({ canActivate: vi.fn() })
      .overrideGuard(RoleGuard)
      .useValue({ canActivate: vi.fn() })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: vi.fn() })
      .compile();

    pageController = module.get(AirportTripCompletionPageController);
    fleetController = module.get(FleetOwnerAirportTripCompletionController);
  });

  it("renders the confirmation page without completing the trip", async () => {
    statusChangeService.getAirportCompletionDetails.mockResolvedValueOnce({
      id: "booking-1",
      bookingReference: "REF-1",
      status: "ACTIVE",
      pickupLocation: "Airport",
      returnLocation: "Hotel",
      completedAt: null,
      car: { make: "Toyota", model: "Camry", year: 2024 },
    });

    const html = await pageController.showCompletionPage("booking-1", { token: "secret-token" });

    expect(statusChangeService.getAirportCompletionDetails).toHaveBeenCalledWith(
      "booking-1",
      hashBookingCompletionToken("secret-token"),
    );
    expect(statusChangeService.completeAirportBookingWithToken).not.toHaveBeenCalled();
    expect(html).toContain("Confirm trip completed");
  });

  it("completes the trip only on POST", async () => {
    statusChangeService.completeAirportBookingWithToken.mockResolvedValueOnce({
      id: "booking-1",
      bookingReference: "REF-1",
      status: "COMPLETED",
      pickupLocation: "Airport",
      returnLocation: "Hotel",
      completedAt: new Date("2026-08-17T12:00:00.000Z"),
      car: { make: "Toyota", model: "Camry", year: 2024 },
    });

    const html = await pageController.completeFromPage("booking-1", { token: "secret-token" });

    expect(statusChangeService.completeAirportBookingWithToken).toHaveBeenCalledWith(
      "booking-1",
      hashBookingCompletionToken("secret-token"),
    );
    expect(html).toContain("Trip already completed");
  });

  it("renders the invalid page when the token is missing", async () => {
    const html = await pageController.showCompletionPage("booking-1", {});

    expect(statusChangeService.getAirportCompletionDetails).not.toHaveBeenCalled();
    expect(html).toContain("invalid or no longer active");
  });

  it("completes a fleet-owned trip as the fleet owner", async () => {
    await fleetController.completeTrip("booking-1", {
      id: "owner-1",
      roles: [FLEET_OWNER],
    } as never);

    expect(statusChangeService.completeAirportBookingForUser).toHaveBeenCalledWith(
      "booking-1",
      "owner-1",
      BookingCompletionSource.FLEET_OWNER,
    );
  });

  it("records privileged completion as an operations action", async () => {
    await fleetController.completeTrip("booking-1", {
      id: "admin-1",
      roles: [ADMIN],
    } as never);

    expect(statusChangeService.completeAirportBookingForUser).toHaveBeenCalledWith(
      "booking-1",
      "admin-1",
      BookingCompletionSource.OPERATIONS,
    );
  });
});
