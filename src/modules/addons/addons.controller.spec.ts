import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddonsController } from "./addons.controller";
import { AddonsService } from "./addons.service";

describe("AddonsController", () => {
  let controller: AddonsController;
  let addonsService: { listPublic: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    addonsService = { listPublic: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AddonsController],
      providers: [{ provide: AddonsService, useValue: addonsService }],
    }).compile();
    controller = module.get(AddonsController);
  });

  it("delegates public listing to the service", async () => {
    const response = { addons: [] };
    addonsService.listPublic.mockResolvedValue(response);

    await expect(controller.list({ bookingType: "DAY" })).resolves.toEqual(response);
    expect(addonsService.listPublic).toHaveBeenCalledWith("DAY");
  });
});
