import { Injectable, Logger } from "@nestjs/common";
import { BookingStatus, PayoutTransactionStatus } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import { DASHBOARD_RANGE_DAYS } from "./dashboard.const";
import {
  DashboardException,
  DashboardFetchFailedException,
  DashboardValidationException,
} from "./dashboard.error";
import type {
  DashboardGroupBy,
  EarningsBucket,
  PayoutStatusBreakdown,
} from "./dashboard.interface";
import type { DashboardEarningsQueryDto, DashboardPayoutsQueryDto } from "./dto/dashboard.dto";

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  private toNumber(value: { toNumber(): number } | null | undefined): number {
    return value ? value.toNumber() : 0;
  }

  private getRangeWindow(query: DashboardEarningsQueryDto | DashboardPayoutsQueryDto): {
    from: Date;
    to: Date;
  } {
    const now = new Date();
    const to = query.to ?? now;

    if ("range" in query && query.range === "custom") {
      if (!query.from || !query.to) {
        throw new DashboardValidationException("Custom range requires both from and to dates");
      }

      if (query.from > query.to) {
        throw new DashboardValidationException("from date must be before to date");
      }

      return { from: query.from, to: query.to };
    }

    if ("from" in query && query.from && query.to && query.from > query.to) {
      throw new DashboardValidationException("from date must be before to date");
    }

    if ("range" in query) {
      const rangeDays = query.range === "custom" ? 30 : DASHBOARD_RANGE_DAYS[query.range];
      const from = new Date(to);
      from.setDate(from.getDate() - rangeDays);
      return { from, to };
    }

    return {
      from: query.from ?? new Date(new Date(to).setDate(to.getDate() - 30)),
      to,
    };
  }

  private getBucketStart(date: Date, groupBy: DashboardGroupBy): Date {
    const bucket = new Date(date);
    bucket.setHours(0, 0, 0, 0);

    if (groupBy === "month") {
      bucket.setDate(1);
      return bucket;
    }

    if (groupBy === "week") {
      const day = bucket.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      bucket.setDate(bucket.getDate() + diff);
    }

    return bucket;
  }

  async getOverview(ownerId: string) {
    try {
      const [bookings, carsCount, payoutSummary] = await Promise.all([
        this.databaseService.booking.findMany({
          where: {
            deletedAt: null,
            car: { ownerId },
          },
          select: {
            status: true,
            chauffeurId: true,
          },
        }),
        this.databaseService.car.count({ where: { ownerId } }),
        this.databaseService.payoutTransaction.aggregate({
          where: { fleetOwnerId: ownerId },
          _sum: { amountToPay: true, amountPaid: true },
        }),
      ]);

      const completedBookings = bookings.filter(
        (booking) => booking.status === BookingStatus.COMPLETED,
      );
      const cancelledBookings = bookings.filter(
        (booking) => booking.status === BookingStatus.CANCELLED,
      );
      const activeStatuses = new Set<BookingStatus>([
        BookingStatus.PENDING,
        BookingStatus.CONFIRMED,
        BookingStatus.ACTIVE,
      ]);
      const activeBookings = bookings.filter((booking) => activeStatuses.has(booking.status));
      const ownerDriverTrips = completedBookings.filter(
        (booking) => booking.chauffeurId != null && booking.chauffeurId === ownerId,
      ).length;

      return {
        totalBookings: bookings.length,
        completedBookings: completedBookings.length,
        activeBookings: activeBookings.length,
        cancelledBookings: cancelledBookings.length,
        carsCount,
        ownerDriverTrips,
        chauffeurTrips: completedBookings.length - ownerDriverTrips,
        totalEarnings: this.toNumber(payoutSummary._sum.amountPaid),
        pendingPayoutAmount: this.toNumber(payoutSummary._sum.amountToPay),
      };
    } catch (error) {
      if (error instanceof DashboardException) {
        throw error;
      }
      this.logger.error("Failed to get dashboard overview", {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DashboardFetchFailedException();
    }
  }

  async getEarnings(ownerId: string, query: DashboardEarningsQueryDto) {
    try {
      const { from, to } = this.getRangeWindow(query);

      const bookings = await this.databaseService.booking.findMany({
        where: {
          deletedAt: null,
          car: { ownerId },
          status: BookingStatus.COMPLETED,
          endDate: {
            gte: from,
            lte: to,
          },
        },
        select: {
          endDate: true,
          fleetOwnerPayoutAmountNet: true,
          platformFleetOwnerCommissionAmount: true,
        },
        orderBy: { endDate: "asc" },
      });

      const seriesMap = new Map<string, EarningsBucket>();

      for (const booking of bookings) {
        const bucket = this.getBucketStart(booking.endDate, query.groupBy).toISOString();
        const net = this.toNumber(booking.fleetOwnerPayoutAmountNet);
        const fees = this.toNumber(booking.platformFleetOwnerCommissionAmount);
        const gross = net + fees;

        if (!seriesMap.has(bucket)) {
          seriesMap.set(bucket, {
            bucketStart: bucket,
            gross: 0,
            net: 0,
            fees: 0,
            refunds: 0,
            rides: 0,
          });
        }

        const entry = seriesMap.get(bucket);
        if (entry) {
          entry.gross += gross;
          entry.net += net;
          entry.fees += fees;
          entry.rides += 1;
        }
      }

      const series = Array.from(seriesMap.values()).sort((a, b) =>
        a.bucketStart.localeCompare(b.bucketStart),
      );

      return {
        range: {
          from: from.toISOString(),
          to: to.toISOString(),
          groupBy: query.groupBy,
        },
        totals: {
          gross: series.reduce((sum, entry) => sum + entry.gross, 0),
          net: series.reduce((sum, entry) => sum + entry.net, 0),
          fees: series.reduce((sum, entry) => sum + entry.fees, 0),
          refunds: 0,
          rides: series.reduce((sum, entry) => sum + entry.rides, 0),
        },
        series,
      };
    } catch (error) {
      if (error instanceof DashboardException) {
        throw error;
      }
      this.logger.error("Failed to get dashboard earnings", {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DashboardFetchFailedException();
    }
  }

  async getPayouts(ownerId: string, query: DashboardPayoutsQueryDto) {
    try {
      const { from, to } = this.getRangeWindow(query);
      const where = {
        fleetOwnerId: ownerId,
        ...(query.status && { status: query.status }),
        initiatedAt: {
          gte: from,
          lte: to,
        },
      };

      const [items, total] = await Promise.all([
        this.databaseService.payoutTransaction.findMany({
          where,
          orderBy: { initiatedAt: "desc" },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          select: {
            id: true,
            amountToPay: true,
            amountPaid: true,
            currency: true,
            status: true,
            payoutProviderReference: true,
            initiatedAt: true,
            processedAt: true,
            completedAt: true,
            notes: true,
            bookingId: true,
            extensionId: true,
          },
        }),
        this.databaseService.payoutTransaction.count({ where }),
      ]);

      return {
        page: query.page,
        limit: query.limit,
        total,
        items: items.map((item) => ({
          ...item,
          amountToPay: this.toNumber(item.amountToPay),
          amountPaid: this.toNumber(item.amountPaid),
        })),
      };
    } catch (error) {
      if (error instanceof DashboardException) {
        throw error;
      }
      this.logger.error("Failed to get dashboard payouts", {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DashboardFetchFailedException();
    }
  }

  async getPayoutSummary(ownerId: string) {
    try {
      const [statusGroups, totals] = await Promise.all([
        this.databaseService.payoutTransaction.groupBy({
          by: ["status"],
          where: { fleetOwnerId: ownerId },
          _count: { _all: true },
          _sum: { amountToPay: true, amountPaid: true },
        }),
        this.databaseService.payoutTransaction.aggregate({
          where: { fleetOwnerId: ownerId },
          _max: { completedAt: true },
        }),
      ]);

      const byStatus = Object.values(PayoutTransactionStatus).reduce((acc, status) => {
        const match = statusGroups.find((item) => item.status === status);
        acc[status] = {
          count: match?._count._all ?? 0,
          amountToPay: this.toNumber(match?._sum.amountToPay),
          amountPaid: this.toNumber(match?._sum.amountPaid),
        };
        return acc;
      }, {} as PayoutStatusBreakdown);

      return {
        totalPaidOut:
          byStatus[PayoutTransactionStatus.PAID_OUT].amountPaid ||
          byStatus[PayoutTransactionStatus.PAID_OUT].amountToPay,
        pendingPayouts:
          byStatus[PayoutTransactionStatus.PENDING_APPROVAL].amountToPay +
          byStatus[PayoutTransactionStatus.PENDING_DISBURSEMENT].amountToPay +
          byStatus[PayoutTransactionStatus.PROCESSING].amountToPay,
        failedPayouts: byStatus[PayoutTransactionStatus.FAILED].amountToPay,
        lastPayoutAt: totals._max.completedAt,
        statusBreakdown: byStatus,
      };
    } catch (error) {
      if (error instanceof DashboardException) {
        throw error;
      }
      this.logger.error("Failed to get dashboard payout summary", {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DashboardFetchFailedException();
    }
  }
}
