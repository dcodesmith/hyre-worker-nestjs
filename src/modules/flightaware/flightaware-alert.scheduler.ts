import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { BookingStatus, BookingType, PaymentStatus } from "@prisma/client";
import { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import {
  observeBackgroundOperation,
  reportBackgroundFailure,
} from "../../common/observability/background-operation";
import { CREATE_FLIGHT_ALERT_JOB, FLIGHT_ALERTS_QUEUE } from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import type { FlightAlertJobData } from "./flightaware-alert.interface";

const RECONCILIATION_WINDOW_MS = 5 * 60 * 1000;
const DEPARTURE_RECOVERY_WINDOW_MS = 48 * 60 * 60 * 1000;
const ALERT_RETRY_BACKOFF_MS = 15 * 60 * 1000;

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
    return observeBackgroundOperation(
      "FlightAwareAlertScheduler.reconcileMissingAlerts",
      "scheduler",
      () => this.reconcileAlerts(),
    );
  }

  private async reconcileAlerts(): Promise<void> {
    const now = new Date();

    try {
      const retryBefore = new Date(now.getTime() - ALERT_RETRY_BACKOFF_MS);
      const flights = await this.databaseService.flight.findMany({
        where: {
          alertEnabled: false,
          OR: [{ alertLastAttemptAt: null }, { alertLastAttemptAt: { lte: retryBefore } }],
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
      let enqueued = 0;
      let failed = 0;
      let skipped = 0;
      let firstFailure: unknown;

      for (const flight of flights) {
        if (!flight.scheduledDeparture) {
          skipped += 1;
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
          enqueued += 1;
        } catch (error) {
          failed += 1;
          firstFailure ??= error;
          this.logger.error(
            {
              flightId: flight.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to requeue missing FlightAware alert",
          );
        }
      }

      if (firstFailure) {
        reportBackgroundFailure(firstFailure, {
          message: "Failed to requeue one or more FlightAware alerts",
          operation: "FlightAwareAlertScheduler.reconcileMissingAlerts",
          source: "scheduler",
        });
      }

      this.logger.info(
        { found: flights.length, enqueued, failed, skipped },
        "Reconciled missing FlightAware alerts",
      );
    } catch (error) {
      reportBackgroundFailure(error, {
        message: "Failed to reconcile missing FlightAware alerts",
        operation: "FlightAwareAlertScheduler.reconcileMissingAlerts",
        source: "scheduler",
      });
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to reconcile missing FlightAware alerts",
      );
    }
  }
}
