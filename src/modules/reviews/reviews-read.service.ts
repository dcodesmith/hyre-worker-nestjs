import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { ReviewQueryDto } from "./dto/reviews.dto";

type RatingDistribution = { 1: number; 2: number; 3: number; 4: number; 5: number };

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
      include: {
        booking: {
          include: {
            car: true,
            chauffeur: true,
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
    });
  }

  async getReviewByBookingId(bookingId: string) {
    return this.databaseService.review.findFirst({
      where: { bookingId, isVisible: true },
      include: {
        booking: {
          include: {
            car: true,
            chauffeur: true,
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
    });
  }

  async getCarReviews(carId: string, query: ReviewQueryDto) {
    const whereClause = {
      isVisible: true,
      booking: { carId },
    };

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
      ? this.getCarRatings(carId)
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

  async getChauffeurReviews(chauffeurId: string, query: ReviewQueryDto) {
    const whereClause = {
      isVisible: true,
      booking: { chauffeurId },
    };

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
      ? this.getChauffeurRatings(chauffeurId)
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
    if (ratings.length === 0) {
      return {
        averageRating: 0,
        totalReviews: 0,
        ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      };
    }

    const total = ratings.reduce((sum, rating) => sum + rating, 0);
    const distribution: RatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    for (const rating of ratings) {
      const key = Math.max(1, Math.min(5, rating)) as keyof RatingDistribution;
      distribution[key] += 1;
    }

    return {
      averageRating: Math.round((total / ratings.length) * 10) / 10,
      totalReviews: ratings.length,
      ratingDistribution: distribution,
    };
  }
}
