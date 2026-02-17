import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReview } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { ReviewsReadService } from "./reviews-read.service";

describe("ReviewsReadService", () => {
  let service: ReviewsReadService;
  let databaseService: DatabaseService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsReadService,
        {
          provide: DatabaseService,
          useValue: {
            review: {
              findFirst: vi.fn(),
              findMany: vi.fn(),
              count: vi.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<ReviewsReadService>(ReviewsReadService);
    databaseService = module.get<DatabaseService>(DatabaseService);
  });

  it("returns car reviews with pagination", async () => {
    vi.mocked(databaseService.review.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createReview({ carRating: 5 }), createReview({ carRating: 4 })]);
    vi.mocked(databaseService.review.count).mockResolvedValueOnce(0);

    const result = await service.getCarReviews("car-1", {
      page: 1,
      limit: 10,
      includeRatings: true,
    });

    expect(result.pagination.page).toBe(1);
    expect(result).toHaveProperty("ratings");
  });

  it("returns chauffeur reviews with pagination", async () => {
    vi.mocked(databaseService.review.findMany).mockResolvedValueOnce([]);
    vi.mocked(databaseService.review.count).mockResolvedValueOnce(0);

    const result = await service.getChauffeurReviews("chauffeur-1", {
      page: 1,
      limit: 10,
      includeRatings: false,
    });

    expect(result.pagination.limit).toBe(10);
    expect(result).not.toHaveProperty("ratings");
  });
});
