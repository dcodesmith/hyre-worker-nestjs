import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReview } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { ReviewNotFoundException } from "./reviews.error";
import { ReviewsModerationService } from "./reviews-moderation.service";

describe("ReviewsModerationService", () => {
  let service: ReviewsModerationService;
  let databaseService: DatabaseService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsModerationService,
        {
          provide: DatabaseService,
          useValue: {
            review: {
              findUnique: vi.fn(),
              update: vi.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<ReviewsModerationService>(ReviewsModerationService);
    databaseService = module.get<DatabaseService>(DatabaseService);
  });

  it("hides visible review", async () => {
    vi.mocked(databaseService.review.findUnique).mockResolvedValueOnce(
      createReview({
        id: "review-1",
        isVisible: true,
      }),
    );
    vi.mocked(databaseService.review.update).mockResolvedValueOnce(
      createReview({
        id: "review-1",
        isVisible: false,
      }),
    );

    const result = await service.hideReview("review-1", "admin-1", "Spam");

    expect(result).toEqual(
      createReview({
        id: "review-1",
        isVisible: false,
      }),
    );
    expect(databaseService.review.update).toHaveBeenCalled();
  });

  it("returns existing review when already hidden", async () => {
    vi.mocked(databaseService.review.findUnique)
      .mockResolvedValueOnce(
        createReview({
          id: "review-1",
          isVisible: false,
        }),
      )
      .mockResolvedValueOnce(
        createReview({
          id: "review-1",
          isVisible: false,
        }),
      );

    const result = await service.hideReview("review-1", "admin-1");

    expect(result).toEqual(
      createReview({
        id: "review-1",
        isVisible: false,
      }),
    );
  });

  it("throws when review is not found", async () => {
    vi.mocked(databaseService.review.findUnique).mockResolvedValueOnce(null);

    await expect(service.hideReview("review-1", "admin-1")).rejects.toThrow(
      ReviewNotFoundException,
    );
  });
});
