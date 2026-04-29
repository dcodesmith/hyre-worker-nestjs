import { describe, expect, it, vi } from "vitest";
import { CarPromotionEnrichmentService, type PromotionTarget } from "./car-promotion.enrichment";

describe("car-promotion.enrichment", () => {
  const createSut = () => {
    const promotionService = {
      getActivePromotionsForCars: vi.fn(),
      getActivePromotionForCar: vi.fn(),
    };
    const logger = {
      setContext: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const service = new CarPromotionEnrichmentService(promotionService as never, logger as never);

    return { service, promotionService };
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
    const { service, promotionService } = createSut();
    const targets: PromotionTarget[] = [{ id: "car-1", ownerId: "owner-1" }];
    promotionService.getActivePromotionsForCars.mockRejectedValueOnce(new Error("promotion down"));

    const result = await service.resolvePromotionsForCars({
      targets,
      referenceDate: new Date("2026-03-01T00:00:00.000Z"),
      failureMessage: "promotion batch failed",
    });

    expect(result.get("car-1")).toBeNull();
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
    const { service, promotionService } = createSut();
    promotionService.getActivePromotionForCar.mockRejectedValueOnce(new Error("promotion down"));

    const result = await service.resolvePromotionForCar({
      target: { id: "car-1", ownerId: "owner-1" },
      referenceDate: new Date("2026-03-01T00:00:00.000Z"),
      failureMessage: "promotion single failed",
    });

    expect(result).toBeNull();
  });

  it("enriches cars with promotions using shared helper", async () => {
    const { service, promotionService } = createSut();
    promotionService.getActivePromotionsForCars.mockResolvedValueOnce(
      new Map([
        [
          "car-1",
          {
            id: "promo-1",
            name: "Weekend Deal",
            discountValue: 18,
          },
        ],
      ]),
    );

    const result = await service.enrichCarsWithPromotion({
      cars: [
        { id: "car-1", ownerId: "owner-1", make: "Toyota" },
        { id: "car-2", ownerId: "owner-1", make: "Honda" },
      ],
      referenceDate: new Date("2026-03-01T00:00:00.000Z"),
      failureMessage: "promotion batch helper failed",
    });

    expect(result).toEqual([
      {
        id: "car-1",
        ownerId: "owner-1",
        make: "Toyota",
        promotion: {
          id: "promo-1",
          name: "Weekend Deal",
          discountValue: 18,
        },
      },
      {
        id: "car-2",
        ownerId: "owner-1",
        make: "Honda",
        promotion: null,
      },
    ]);
  });

  it("enriches single car with promotion using shared helper", async () => {
    const { service, promotionService } = createSut();
    promotionService.getActivePromotionForCar.mockResolvedValueOnce({
      id: "promo-1",
      name: "Weekend Deal",
      discountValue: 25,
    });

    const result = await service.enrichCarWithPromotion({
      car: { id: "car-1", ownerId: "owner-1", make: "Toyota" },
      referenceDate: new Date("2026-03-01T00:00:00.000Z"),
      failureMessage: "promotion single helper failed",
    });

    expect(result).toEqual({
      id: "car-1",
      ownerId: "owner-1",
      make: "Toyota",
      promotion: {
        id: "promo-1",
        name: "Weekend Deal",
        discountValue: 25,
      },
    });
  });
});
