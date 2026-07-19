import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { ReviewsReadService } from "../reviews/reviews-read.service";

@Injectable()
export class CarRatingsEnrichmentService {
  constructor(
    private readonly reviewsReadService: ReviewsReadService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CarRatingsEnrichmentService.name);
  }

  /**
   * Attaches averageRating/totalReviews for car cards.
   * Ratings failures never fail the parent list/detail response.
   */
  async enrichCarsWithRatings<T extends { id: string }>({
    cars,
    failureMessage,
  }: {
    cars: T[];
    failureMessage: string;
  }): Promise<Array<T & { averageRating: number; totalReviews: number }>> {
    let ratingsByCarId = new Map<string, { averageRating: number; totalReviews: number }>();
    try {
      ratingsByCarId = await this.reviewsReadService.getBatchCarRatings(cars.map((car) => car.id));
    } catch (ratingsError) {
      this.logger.warn(
        {
          carCount: cars.length,
          error: ratingsError instanceof Error ? ratingsError.message : String(ratingsError),
        },
        failureMessage,
      );
    }

    return cars.map((car) => {
      const ratings = ratingsByCarId.get(car.id);
      return {
        ...car,
        averageRating: ratings?.averageRating ?? 0,
        totalReviews: ratings?.totalReviews ?? 0,
      };
    });
  }
}
