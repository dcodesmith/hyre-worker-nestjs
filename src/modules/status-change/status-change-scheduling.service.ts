import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { BookingStatus, BookingType, PaymentStatus } from "@prisma/client";
import { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { ACTIVATE_AIRPORT_BOOKING, STATUS_UPDATES_QUEUE } from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import { StatusUpdateSchedulingFailedException } from "./status-change.error";
import type { ActivateAirportBookingJobData, StatusUpdateJobData } from "./status-change.interface";

@Injectable()
export class StatusChangeSchedulingService {
  constructor(
    private readonly databaseService: DatabaseService,
    @InjectQueue(STATUS_UPDATES_QUEUE)
    private readonly statusUpdateQueue: Queue<StatusUpdateJobData>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StatusChangeSchedulingService.name);
  }

  async scheduleAirportActivation(bookingId: string, activationAt: Date): Promise<void> {
    const delay = Math.max(0, activationAt.getTime() - Date.now());
    const jobId = this.getAirportActivationJobId(bookingId);
    const payload: ActivateAirportBookingJobData = {
      type: ACTIVATE_AIRPORT_BOOKING,
      bookingId,
      activationAt: activationAt.toISOString(),
    };

    try {
      const existingJob = await this.statusUpdateQueue.getJob(jobId);
      if (existingJob) {
        await existingJob.remove();
      }

      await this.statusUpdateQueue.add(ACTIVATE_AIRPORT_BOOKING, payload, {
        jobId,
        delay,
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const wrappedError = new StatusUpdateSchedulingFailedException(
        ACTIVATE_AIRPORT_BOOKING,
        reason,
      );
      this.logger.error(
        {
          bookingId,
          activationAt: activationAt.toISOString(),
          error: wrappedError.message,
        },
        "Airport activation scheduling failed",
      );
      throw wrappedError;
    }
  }

  async scheduleAirportActivationsForFlight(flightId: string, activationAt: Date): Promise<void> {
    let bookings: Array<{ id: string }>;
    try {
      bookings = await this.databaseService.booking.findMany({
        where: {
          flightId,
          type: BookingType.AIRPORT_PICKUP,
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          deletedAt: null,
        },
        select: { id: true },
      });
    } catch (error) {
      this.logger.error(
        {
          flightId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to fetch airport bookings for flight activation scheduling",
      );
      throw error;
    }

    if (bookings.length === 0) {
      return;
    }

    const schedulingResults = await Promise.allSettled(
      bookings.map((booking) => this.scheduleAirportActivation(booking.id, activationAt)),
    );
    const failedSchedulingResults = schedulingResults.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    if (failedSchedulingResults.length > 0) {
      const firstFailure = failedSchedulingResults[0].reason;
      const reason = firstFailure instanceof Error ? firstFailure.message : String(firstFailure);
      throw new Error(
        `Failed to schedule ${failedSchedulingResults.length} airport activations for flight ${flightId}: ${reason}`,
      );
    }
  }

  private getAirportActivationJobId(bookingId: string): string {
    return `activate-airport-booking-${bookingId}`;
  }
}
