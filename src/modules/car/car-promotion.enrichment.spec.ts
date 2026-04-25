import { describe, expect, it, vi } from "vitest";
import { CarPromotionEnrichmentService, type PromotionTarget } from "./car-promotion.enrichment";

describe("car-promotion.enrichment", () => {
  const createSut = () => {
    const promotionService = {
      getActivePromotionsForCars: vi.fn(),
      getActivePromotionForCar: vi.fn(),
    };
    const service = new CarPromotionEnrichmentService(promotionService as never);
    const loggerWarnSpy = vi.spyOn(service["logger"], "warn").mockImplementation(() => undefined);

    return { service, promotionService, loggerWarnSpy };
  };

  it("maps active promotions for multiple cars", async () => {
    const { service, promotionService } = createSut();
    const targets: PromotionTarget[] = [
      { id: "car-1", ownerId: "owner-1" },
      { id: "car-2", ownerId: "owner-1" },
    ];
    promotionService.getActivePromotionsForCars.mockResolvedValueOnce(
      new Map([
        [
          "car-1",
          {
            id: "promo-1",
            name: "Weekend Deal",
            discountValue: 20,
          },
        ],
      ]),
    );

    const result = await service.resolvePromotionsForCars({
      targets,
      referenceDate: new Date("2026-03-01T00:00:00.000Z"),
      failureMessage: "promotion batch failed",
    });

    expect(result.get("car-1")).toEqual({
      id: "promo-1",
      name: "Weekend Deal",
      discountValue: 20,
    });
    expect(result.get("car-2")).toBeNull();
  });

  it("fails open for multiple cars when promotion lookup throws", async () => {
    const { service, promotionService, loggerWarnSpy } = createSut();
    const targets: PromotionTarget[] = [{ id: "car-1", ownerId: "owner-1" }];
    promotionService.getActivePromotionsForCars.mockRejectedValueOnce(new Error("promotion down"));

    const result = await service.resolvePromotionsForCars({
      targets,
      referenceDate: new Date("2026-03-01T00:00:00.000Z"),
      failureMessage: "promotion batch failed",
    });

    expect(result.get("car-1")).toBeNull();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      "promotion batch failed",
      expect.objectContaining({
        carIds: ["car-1"],
        ownerIds: ["owner-1"],
      }),
    );
  });

  it("maps active promotion for a single car", async () => {
    const { service, promotionService } = createSut();
    promotionService.getActivePromotionForCar.mockResolvedValueOnce({
      id: "promo-1",
      name: "Weekend Deal",
      discountValue: 25,
    });

    const result = await service.resolvePromotionForCar({
      target: { id: "car-1", ownerId: "owner-1" },
      referenceDate: new Date("2026-03-01T00:00:00.000Z"),
      failureMessage: "promotion single failed",
    });

    expect(result).toEqual({
      id: "promo-1",
      name: "Weekend Deal",
      discountValue: 25,
    });
  });

  it("fails open for a single car when promotion lookup throws", async () => {
    const { service, promotionService, loggerWarnSpy } = createSut();
    promotionService.getActivePromotionForCar.mockRejectedValueOnce(new Error("promotion down"));

    const result = await service.resolvePromotionForCar({
      target: { id: "car-1", ownerId: "owner-1" },
      referenceDate: new Date("2026-03-01T00:00:00.000Z"),
      failureMessage: "promotion single failed",
    });

    expect(result).toBeNull();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      "promotion single failed",
      expect.objectContaining({
        carId: "car-1",
        ownerId: "owner-1",
      }),
    );
  });
});
