import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { BookingStatus, BookingType, PaymentStatus } from "@prisma/client";
import { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { CREATE_FLIGHT_ALERT_JOB, FLIGHT_ALERTS_QUEUE } from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import type { FlightAlertJobData } from "./flightaware-alert.interface";

const RECONCILIATION_WINDOW_MS = 5 * 60 * 1000;
const DEPARTURE_RECOVERY_WINDOW_MS = 48 * 60 * 60 * 1000;

@Injectable()
export class FlightAwareAlertScheduler {
  constructor(
    private readonly databaseService: DatabaseService,
    @InjectQueue(FLIGHT_ALERTS_QUEUE)
    private readonly flightAlertQueue: Queue<FlightAlertJobData>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FlightAwareAlertScheduler.name);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcileMissingAlerts(): Promise<void> {
    const now = new Date();

    try {
      const flights = await this.databaseService.flight.findMany({
        where: {
          alertEnabled: false,
          scheduledDeparture: {
            gte: new Date(now.getTime() - DEPARTURE_RECOVERY_WINDOW_MS),
          },
          bookings: {
            some: {
              deletedAt: null,
              type: BookingType.AIRPORT_PICKUP,
              paymentStatus: PaymentStatus.PAID,
              status: {
                in: [BookingStatus.CONFIRMED, BookingStatus.ACTIVE],
              },
            },
          },
        },
        select: {
          id: true,
          flightNumber: true,
          scheduledDeparture: true,
          originCode: true,
          originTimezone: true,
          destinationCodeIATA: true,
        },
        orderBy: { scheduledDeparture: "asc" },
        take: 100,
      });
      const reconciliationBucket = Math.floor(now.getTime() / RECONCILIATION_WINDOW_MS);

      for (const flight of flights) {
        if (!flight.scheduledDeparture) {
          continue;
        }

        try {
          await this.flightAlertQueue.add(
            CREATE_FLIGHT_ALERT_JOB,
            {
              flightId: flight.id,
              flightNumber: flight.flightNumber,
              departureTime: flight.scheduledDeparture.toISOString(),
              originCode: flight.originCode,
              originTimezone: flight.originTimezone ?? undefined,
              destinationIATA: flight.destinationCodeIATA ?? undefined,
            },
            {
              jobId: `flight-alert-reconcile-${flight.id}-${reconciliationBucket}`,
            },
          );
        } catch (error) {
          this.logger.error(
            {
              flightId: flight.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to requeue missing FlightAware alert",
          );
        }
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to reconcile missing FlightAware alerts",
      );
    }
  }
}
