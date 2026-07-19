import { describe, expect, it, vi } from "vitest";
import { CarRatingsEnrichmentService } from "./car-ratings.enrichment";

describe("CarRatingsEnrichmentService", () => {
  const createSut = () => {
    const reviewsReadService = {
      getBatchCarRatings: vi.fn(),
    };
    const logger = {
      setContext: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const service = new CarRatingsEnrichmentService(reviewsReadService as never, logger as never);

    return { service, reviewsReadService, logger };
  };

  it("attaches averageRating and totalReviews from batch lookup", async () => {
    const { service, reviewsReadService } = createSut();
    reviewsReadService.getBatchCarRatings.mockResolvedValueOnce(
      new Map([
        [
          "car-1",
          {
            averageRating: 4.5,
            totalReviews: 2,
            ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 },
          },
        ],
      ]),
    );

    const result = await service.enrichCarsWithRatings({
      cars: [{ id: "car-1" }, { id: "car-2" }],
      failureMessage: "ratings batch failed",
    });

    expect(reviewsReadService.getBatchCarRatings).toHaveBeenCalledWith(["car-1", "car-2"]);
    expect(result).toEqual([
      { id: "car-1", averageRating: 4.5, totalReviews: 2 },
      { id: "car-2", averageRating: 0, totalReviews: 0 },
    ]);
  });

  it("fails open with zero ratings when batch lookup throws", async () => {
    const { service, reviewsReadService, logger } = createSut();
    reviewsReadService.getBatchCarRatings.mockRejectedValueOnce(new Error("ratings down"));

    const result = await service.enrichCarsWithRatings({
      cars: [{ id: "car-1" }],
      failureMessage: "ratings batch failed",
    });

    expect(result).toEqual([{ id: "car-1", averageRating: 0, totalReviews: 0 }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ carCount: 1, error: "ratings down" }),
      "ratings batch failed",
    );
  });

  it("preserves existing promotion fields on the car", async () => {
    const { service, reviewsReadService } = createSut();
    reviewsReadService.getBatchCarRatings.mockResolvedValueOnce(
      new Map([
        [
          "car-1",
          {
            averageRating: 5,
            totalReviews: 1,
            ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 },
          },
        ],
      ]),
    );

    const result = await service.enrichCarsWithRatings({
      cars: [
        {
          id: "car-1",
          promotion: { id: "promo-1", name: "Weekend Deal", discountValue: 20 },
        },
      ],
      failureMessage: "ratings batch failed",
    });

    expect(result[0]).toEqual({
      id: "car-1",
      promotion: { id: "promo-1", name: "Weekend Deal", discountValue: 20 },
      averageRating: 5,
      totalReviews: 1,
    });
  });
});
