import { Injectable, Logger } from "@nestjs/common";
import { BookingStatus, Prisma } from "@prisma/client";
import { subDays } from "date-fns";
import { DatabaseService } from "../database/database.service";
import { NotificationService } from "../notification/notification.service";
import type { CreateReviewDto, UpdateReviewDto } from "./dto/reviews.dto";
import {
  ReviewAlreadyExistsException,
  ReviewBookingChauffeurRequiredException,
  ReviewBookingNotCompletedException,
  ReviewBookingNotFoundException,
  ReviewCreationWindowExpiredException,
  ReviewNotFoundException,
  ReviewOwnershipRequiredException,
  ReviewUpdateWindowExpiredException,
} from "./reviews.error";

type ReviewCreationBooking = {
  id: string;
  userId: string | null;
  status: BookingStatus;
  endDate: Date;
  chauffeurId: string | null;
  bookingReference: string;
  car: {
    make: string;
    model: string;
    year: number;
    owner: {
      id: string;
      name: string | null;
      email: string;
    };
  };
  chauffeur: {
    id: string;
    name: string | null;
    email: string;
  } | null;
  user: {
    name: string | null;
    email: string;
  } | null;
};

type ReviewCreationBookingWithChauffeur = ReviewCreationBooking & {
  chauffeur: {
    id: string;
    name: string | null;
    email: string;
  };
};

@Injectable()
export class ReviewsWriteService {
  private readonly logger = new Logger(ReviewsWriteService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationService: NotificationService,
  ) {}

  async createReview(userId: string, input: CreateReviewDto) {
    const booking = await this.databaseService.booking.findFirst({
      where: { id: input.bookingId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        status: true,
        endDate: true,
        chauffeurId: true,
        bookingReference: true,
        car: {
          select: {
            make: true,
            model: true,
            year: true,
            owner: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
        chauffeur: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        user: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    });

    if (!booking) {
      throw new ReviewBookingNotFoundException();
    }

    if (booking.status !== BookingStatus.COMPLETED) {
      throw new ReviewBookingNotCompletedException();
    }

    if (booking.userId !== userId) {
      throw new ReviewOwnershipRequiredException("You can only review your own bookings");
    }

    if (!booking.chauffeurId) {
      throw new ReviewBookingChauffeurRequiredException();
    }
    if (!booking.chauffeur) {
      throw new ReviewBookingChauffeurRequiredException();
    }
    const bookingWithChauffeur: ReviewCreationBookingWithChauffeur = booking;

    const thirtyDaysAgo = subDays(new Date(), 30);
    if (booking.endDate < thirtyDaysAgo) {
      throw new ReviewCreationWindowExpiredException();
    }

    try {
      const review = await this.databaseService.review.create({
        data: {
          bookingId: input.bookingId,
          userId,
          overallRating: input.overallRating,
          carRating: input.carRating,
          chauffeurRating: input.chauffeurRating,
          serviceRating: input.serviceRating,
          comment: input.comment ?? null,
          isVisible: true,
        },
      });
      void this.sendReviewNotifications(bookingWithChauffeur, input).catch((error: unknown) => {
        this.logger.error("Failed to dispatch review notifications", {
          bookingReference: bookingWithChauffeur.bookingReference,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return review;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        Array.isArray(error.meta?.target) &&
        error.meta.target.includes("bookingId")
      ) {
        throw new ReviewAlreadyExistsException();
      }
      throw error;
    }
  }

  async updateReview(userId: string, reviewId: string, input: UpdateReviewDto) {
    const existingReview = await this.databaseService.review.findUnique({
      where: { id: reviewId },
      select: {
        id: true,
        bookingId: true,
        userId: true,
        isVisible: true,
        createdAt: true,
      },
    });

    if (!existingReview) {
      throw new ReviewNotFoundException();
    }

    if (!existingReview.isVisible) {
      throw new ReviewNotFoundException();
    }

    if (existingReview.userId !== userId) {
      throw new ReviewOwnershipRequiredException("You can only update your own reviews");
    }

    const sevenDaysAgo = subDays(new Date(), 7);
    if (existingReview.createdAt < sevenDaysAgo) {
      throw new ReviewUpdateWindowExpiredException();
    }

    return this.databaseService.review.update({
      where: { id: reviewId },
      data: {
        ...(input.overallRating !== undefined && { overallRating: input.overallRating }),
        ...(input.carRating !== undefined && { carRating: input.carRating }),
        ...(input.chauffeurRating !== undefined && { chauffeurRating: input.chauffeurRating }),
        ...(input.serviceRating !== undefined && { serviceRating: input.serviceRating }),
        ...(input.comment !== undefined && { comment: input.comment }),
      },
    });
  }

  private async sendReviewNotifications(
    booking: ReviewCreationBookingWithChauffeur,
    input: CreateReviewDto,
  ): Promise<void> {
    const ownerName = booking.car.owner.name || "Fleet Owner";
    const chauffeurName = booking.chauffeur?.name || "Chauffeur";
    const customerName = booking.user?.name || booking.user?.email || "Customer";
    const carName = booking.car.year
      ? `${booking.car.make} ${booking.car.model} (${booking.car.year})`
      : `${booking.car.make} ${booking.car.model}`;
    await this.notificationService.queueReviewReceivedNotifications({
      bookingId: booking.id,
      owner: {
        name: ownerName,
        email: booking.car.owner.email,
      },
      chauffeur: {
        name: chauffeurName,
        email: booking.chauffeur.email,
      },
      review: {
        customerName,
        bookingReference: booking.bookingReference,
        carName,
        overallRating: input.overallRating,
        carRating: input.carRating,
        chauffeurRating: input.chauffeurRating,
        serviceRating: input.serviceRating,
        comment: input.comment ?? null,
        reviewDate: new Date(),
      },
    });
  }
}
