import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { AddonsService } from "./addons.service";
import { AdminAddonsController } from "./admin-addons.controller";

const adminUser = { id: "admin-1" } as AuthSession["user"];

describe("AdminAddonsController", () => {
  let controller: AdminAddonsController;
  let addonsService: {
    listAdmin: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    createPrice: ReturnType<typeof vi.fn>;
    endPrice: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    addonsService = {
      listAdmin: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      createPrice: vi.fn(),
      endPrice: vi.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminAddonsController],
      providers: [{ provide: AddonsService, useValue: addonsService }],
    })
      .overrideGuard(SessionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RoleGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(AdminAddonsController);
  });

  it("delegates list to the service", async () => {
    addonsService.listAdmin.mockResolvedValue({ addons: [] });
    await expect(controller.list()).resolves.toEqual({ addons: [] });
  });

  it("passes the actor id on create, update, price, and end", async () => {
    const createDto = {
      code: "WIFI_HOTSPOT",
      name: "Wi-Fi",
      bookingTypes: ["DAY" as const],
      pricingUnit: "PER_BOOKING" as const,
      financialTreatment: "PLATFORM" as const,
      isActive: true,
    };
    const priceDto = { amount: 10000, effectiveSince: new Date("2026-01-01") };

    await controller.create(createDto, adminUser);
    await controller.update("addon-1", { isActive: false }, adminUser);
    await controller.createPrice("addon-1", priceDto, adminUser);
    await controller.endPrice("addon-1", "price-1", adminUser);

    expect(addonsService.create).toHaveBeenCalledWith(createDto, "admin-1");
    expect(addonsService.update).toHaveBeenCalledWith("addon-1", { isActive: false }, "admin-1");
    expect(addonsService.createPrice).toHaveBeenCalledWith(
      "addon-1",
      expect.any(Object),
      "admin-1",
    );
    expect(addonsService.endPrice).toHaveBeenCalledWith("addon-1", "price-1", "admin-1");
  });
});
