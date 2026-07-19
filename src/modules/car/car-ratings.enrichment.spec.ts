import { Test, type TestingModule } from "@nestjs/testing";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPinoLogger } from "@/testing/nest-pino-logger.mock";
import { ReviewsReadService } from "../reviews/reviews-read.service";
import { CarRatingsEnrichmentService } from "./car-ratings.enrichment";

describe("CarRatingsEnrichmentService", () => {
  let service: CarRatingsEnrichmentService;
  const reviewsReadServiceMock = {
    getBatchCarRatings: vi.fn(),
  };
  const logger = createMockPinoLogger();

  beforeEach(async () => {
    vi.clearAllMocks();
    reviewsReadServiceMock.getBatchCarRatings.mockResolvedValue(new Map());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CarRatingsEnrichmentService,
        { provide: ReviewsReadService, useValue: reviewsReadServiceMock },
        { provide: PinoLogger, useValue: logger },
      ],
    }).compile();

    service = module.get(CarRatingsEnrichmentService);
  });

  it("attaches averageRating and totalReviews from batch lookup", async () => {
    reviewsReadServiceMock.getBatchCarRatings.mockResolvedValueOnce(
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

    expect(reviewsReadServiceMock.getBatchCarRatings).toHaveBeenCalledWith(["car-1", "car-2"]);
    expect(result).toEqual([
      { id: "car-1", averageRating: 4.5, totalReviews: 2 },
      { id: "car-2", averageRating: 0, totalReviews: 0 },
    ]);
  });

  it("fails open with zero ratings when batch lookup throws", async () => {
    reviewsReadServiceMock.getBatchCarRatings.mockRejectedValueOnce(new Error("ratings down"));

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
});
