import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOwnerPromotionListItem, createPromotionRecord } from "../../shared/helper.fixtures";
import { AuthService } from "../auth/auth.service";
import { FleetOwnerPromotionController } from "./fleet-owner-promotion.controller";
import { PromotionService } from "./promotion.service";

describe("FleetOwnerPromotionController", () => {
  let controller: FleetOwnerPromotionController;
  let promotionService: PromotionService;

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
      controllers: [FleetOwnerPromotionController],
      providers: [
        {
          provide: PromotionService,
          useValue: {
            getOwnerPromotions: vi.fn(),
            createPromotion: vi.fn(),
            deactivatePromotion: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            isInitialized: true,
            auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
            getUserRoles: vi.fn().mockResolvedValue(["fleetOwner"]),
          },
        },
        Reflector,
      ],
    }).compile();

    controller = module.get<FleetOwnerPromotionController>(FleetOwnerPromotionController);
    promotionService = module.get<PromotionService>(PromotionService);
  });

  describe("listOwnerPromotions", () => {
    it("delegates to PromotionService.getOwnerPromotions with the caller's id", async () => {
      vi.mocked(promotionService.getOwnerPromotions).mockResolvedValueOnce([
        createOwnerPromotionListItem({ id: "promo-1" }),
      ]);

      const result = await controller.listOwnerPromotions(mockUser);

      expect(result).toEqual([createOwnerPromotionListItem({ id: "promo-1" })]);
      expect(promotionService.getOwnerPromotions).toHaveBeenCalledWith("owner-1");
    });
  });

  describe("createPromotion", () => {
    it("converts calendar dates to exclusive window and passes carId for CAR scope", async () => {
      vi.mocked(promotionService.createPromotion).mockResolvedValueOnce(
        createPromotionRecord({ id: "promo-1" }),
      );

      const body = {
        name: "Easter Special",
        scope: "CAR" as const,
        carId: "ckv123car0000000000000000",
        discountValue: 20,
        startDate: "2026-04-10",
        endDate: "2026-04-12",
      };

      const result = await controller.createPromotion(body, mockUser);

      expect(result).toEqual(createPromotionRecord({ id: "promo-1" }));
      expect(promotionService.createPromotion).toHaveBeenCalledTimes(1);
      const call = vi.mocked(promotionService.createPromotion).mock.calls[0][0];
      expect(call.ownerId).toBe("owner-1");
      expect(call.carId).toBe(body.carId);
      expect(call.name).toBe(body.name);
      expect(call.discountValue).toBe(20);

      expect(call.startDate).toBe(body.startDate);
      expect(call.endDate).toBe(body.endDate);
    });

    it("maps FLEET scope to a fleet-wide promotion (carId=null)", async () => {
      vi.mocked(promotionService.createPromotion).mockResolvedValueOnce(
        createPromotionRecord({ id: "promo-2" }),
      );

      await controller.createPromotion(
        {
          scope: "FLEET",
          discountValue: 15,
          startDate: "2026-04-10",
          endDate: "2026-04-12",
        },
        mockUser,
      );

      const call = vi.mocked(promotionService.createPromotion).mock.calls[0][0];
      expect(call.carId).toBeNull();
    });
  });

  describe("deactivatePromotion", () => {
    it("delegates to PromotionService.deactivatePromotion with promotion id and caller id", async () => {
      vi.mocked(promotionService.deactivatePromotion).mockResolvedValueOnce(
        createPromotionRecord({ id: "promo-1", isActive: false }),
      );

      const result = await controller.deactivatePromotion("promo-1", mockUser);

      expect(result).toEqual(createPromotionRecord({ id: "promo-1", isActive: false }));
      expect(promotionService.deactivatePromotion).toHaveBeenCalledWith("promo-1", "owner-1");
    });
  });
});
