import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { ReviewQueryDto } from "./dto/reviews.dto";

type RatingDistribution = { 1: number; 2: number; 3: number; 4: number; 5: number };
type EntityReviewsWhereClause =
  | { isVisible: true; booking: { carId: string } }
  | { isVisible: true; booking: { chauffeurId: string } };

export type AggregatedRatings = {
  averageRating: number;
  totalReviews: number;
  ratingDistribution: RatingDistribution;
};

@Injectable()
export class ReviewsReadService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getReviewById(reviewId: string) {
    return this.databaseService.review.findFirst({
      where: { id: reviewId, isVisible: true },
      select: this.reviewDetailsSelect(),
    });
  }

  async getReviewByBookingId(bookingId: string) {
    return this.databaseService.review.findFirst({
      where: { bookingId, isVisible: true },
      select: this.reviewDetailsSelect(),
    });
  }

  async getCarReviews(carId: string, query: ReviewQueryDto) {
    return this.getEntityReviews({
      query,
      whereClause: {
        isVisible: true,
        booking: { carId },
      },
      ratingsLoader: () => this.getCarRatings(carId),
    });
  }

  async getChauffeurReviews(chauffeurId: string, query: ReviewQueryDto) {
    return this.getEntityReviews({
      query,
      whereClause: {
        isVisible: true,
        booking: { chauffeurId },
      },
      ratingsLoader: () => this.getChauffeurRatings(chauffeurId),
    });
  }

  private async getEntityReviews({
    query,
    whereClause,
    ratingsLoader,
  }: {
    query: ReviewQueryDto;
    whereClause: EntityReviewsWhereClause;
    ratingsLoader: () => Promise<AggregatedRatings>;
  }) {
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;

    const reviewsPromise = this.databaseService.review.findMany({
      where: whereClause,
      include: {
        booking: {
          select: {
            id: true,
            carId: true,
            chauffeurId: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    });

    const totalPromise = this.databaseService.review.count({ where: whereClause });
    const ratingsPromise = query.includeRatings
      ? ratingsLoader()
      : Promise.resolve<AggregatedRatings | null>(null);

    const [reviews, total, ratings] = await Promise.all([
      reviewsPromise,
      totalPromise,
      ratingsPromise,
    ]);
    const totalPages = Math.ceil(total / limit);

    return {
      reviews,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
      ...(ratings && { ratings }),
    };
  }

  private async getCarRatings(carId: string): Promise<AggregatedRatings> {
    // This reads all ratings into memory (O(n)); consider DB-side aggregation
    // (groupBy/avg/count) or cached aggregates when review volume grows.
    const reviews = await this.databaseService.review.findMany({
      where: {
        isVisible: true,
        booking: { carId },
      },
      select: {
        carRating: true,
      },
    });

    return this.calculateRatings(reviews.map((review) => review.carRating));
  }

  private async getChauffeurRatings(chauffeurId: string): Promise<AggregatedRatings> {
    // This reads all ratings into memory (O(n)); consider DB-side aggregation
    // (groupBy/avg/count) or cached aggregates when review volume grows.
    const reviews = await this.databaseService.review.findMany({
      where: {
        isVisible: true,
        booking: { chauffeurId },
      },
      select: {
        chauffeurRating: true,
      },
    });

    return this.calculateRatings(reviews.map((review) => review.chauffeurRating));
  }

  private calculateRatings(ratings: number[]): AggregatedRatings {
    const normalizedRatings = ratings
      .filter((rating) => typeof rating === "number" && Number.isFinite(rating))
      .map((rating) => Math.max(1, Math.min(5, Math.round(rating))));

    if (normalizedRatings.length === 0) {
      return {
        averageRating: 0,
        totalReviews: 0,
        ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      };
    }

    const total = normalizedRatings.reduce((sum, rating) => sum + rating, 0);
    const distribution: RatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    for (const rating of normalizedRatings) {
      const key = rating as keyof RatingDistribution;
      distribution[key] += 1;
    }

    return {
      averageRating: Math.round((total / normalizedRatings.length) * 10) / 10,
      totalReviews: normalizedRatings.length,
      ratingDistribution: distribution,
    };
  }

  private reviewDetailsSelect() {
    return {
      id: true,
      bookingId: true,
      userId: true,
      overallRating: true,
      carRating: true,
      chauffeurRating: true,
      serviceRating: true,
      comment: true,
      isVisible: true,
      moderatedBy: true,
      moderatedAt: true,
      moderationNotes: true,
      createdAt: true,
      updatedAt: true,
      booking: {
        select: {
          id: true,
          carId: true,
          chauffeurId: true,
          car: {
            select: {
              id: true,
              make: true,
              model: true,
              year: true,
              color: true,
            },
          },
          chauffeur: {
            select: {
              id: true,
              name: true,
              image: true,
            },
          },
        },
      },
      user: {
        select: {
          id: true,
          name: true,
          image: true,
        },
      },
    };
  }
}
