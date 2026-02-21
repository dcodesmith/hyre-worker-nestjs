import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, PayoutTransactionStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { DashboardValidationException } from "./dashboard.error";
import { DashboardService } from "./dashboard.service";

const asDecimal = (value: number) =>
  ({
    toNumber: () => value,
  }) as { toNumber(): number };

describe("DashboardService", () => {
  let service: DashboardService;

  const databaseServiceMock = {
    booking: {
      findMany: vi.fn(),
    },
    car: {
      count: vi.fn(),
    },
    payoutTransaction: {
      aggregate: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [DashboardService, { provide: DatabaseService, useValue: databaseServiceMock }],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
  });

  it("returns overview with owner-driver split and payout totals", async () => {
    databaseServiceMock.booking.findMany.mockResolvedValueOnce([
      { status: BookingStatus.COMPLETED, chauffeurId: "owner-1" },
      { status: BookingStatus.COMPLETED, chauffeurId: "chauffeur-1" },
      { status: BookingStatus.ACTIVE, chauffeurId: "chauffeur-1" },
      { status: BookingStatus.CANCELLED, chauffeurId: null },
    ]);
    databaseServiceMock.car.count.mockResolvedValueOnce(3);
    databaseServiceMock.payoutTransaction.aggregate.mockResolvedValueOnce({
      _sum: { amountToPay: asDecimal(120000), amountPaid: asDecimal(90000) },
    });

    const result = await service.getOverview("owner-1");

    expect(result).toMatchObject({
      totalBookings: 4,
      completedBookings: 2,
      activeBookings: 1,
      cancelledBookings: 1,
      carsCount: 3,
      ownerDriverTrips: 1,
      chauffeurTrips: 1,
      totalEarnings: 90000,
      pendingPayoutAmount: 120000,
    });
  });

  it("throws validation error when custom earnings range is incomplete", async () => {
    await expect(
      service.getEarnings("owner-1", {
        range: "custom",
        groupBy: "day",
        from: new Date("2026-01-01"),
      }),
    ).rejects.toBeInstanceOf(DashboardValidationException);
  });

  it("groups weekly earnings using UTC week boundaries", async () => {
    databaseServiceMock.booking.findMany.mockResolvedValueOnce([
      {
        endDate: new Date("2026-01-04T23:30:00.000Z"),
        fleetOwnerPayoutAmountNet: asDecimal(10000),
        platformFleetOwnerCommissionAmount: asDecimal(1000),
      },
      {
        endDate: new Date("2026-01-05T00:30:00.000Z"),
        fleetOwnerPayoutAmountNet: asDecimal(20000),
        platformFleetOwnerCommissionAmount: asDecimal(2000),
      },
    ]);

    const result = await service.getEarnings("owner-1", {
      range: "custom",
      groupBy: "week",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-31T23:59:59.999Z"),
    });

    expect(result.series).toHaveLength(2);
    expect(result.series[0]?.bucketStart).toBe("2025-12-29T00:00:00.000Z");
    expect(result.series[0]?.gross).toBe(11000);
    expect(result.series[1]?.bucketStart).toBe("2026-01-05T00:00:00.000Z");
    expect(result.series[1]?.gross).toBe(22000);
  });

  it("groups monthly earnings using UTC month start", async () => {
    databaseServiceMock.booking.findMany.mockResolvedValueOnce([
      {
        endDate: new Date("2026-01-31T23:30:00.000Z"),
        fleetOwnerPayoutAmountNet: asDecimal(30000),
        platformFleetOwnerCommissionAmount: asDecimal(3000),
      },
      {
        endDate: new Date("2026-02-01T00:30:00.000Z"),
        fleetOwnerPayoutAmountNet: asDecimal(40000),
        platformFleetOwnerCommissionAmount: asDecimal(4000),
      },
    ]);

    const result = await service.getEarnings("owner-1", {
      range: "custom",
      groupBy: "month",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-02-28T23:59:59.999Z"),
    });

    expect(result.series).toHaveLength(2);
    expect(result.series[0]?.bucketStart).toBe("2026-01-01T00:00:00.000Z");
    expect(result.series[0]?.gross).toBe(33000);
    expect(result.series[1]?.bucketStart).toBe("2026-02-01T00:00:00.000Z");
    expect(result.series[1]?.gross).toBe(44000);
  });

  it("returns paginated payouts list", async () => {
    databaseServiceMock.payoutTransaction.findMany.mockResolvedValueOnce([
      {
        id: "p1",
        amountToPay: asDecimal(45000),
        amountPaid: null,
        currency: "NGN",
        status: PayoutTransactionStatus.PROCESSING,
        payoutProviderReference: "ref-1",
        initiatedAt: new Date("2026-01-01T00:00:00.000Z"),
        processedAt: null,
        completedAt: null,
        notes: null,
        bookingId: "b1",
        extensionId: null,
      },
    ]);
    databaseServiceMock.payoutTransaction.count.mockResolvedValueOnce(1);

    const result = await service.getPayouts("owner-1", {
      page: 1,
      limit: 20,
    });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: "p1",
      amountToPay: 45000,
      amountPaid: 0,
      status: PayoutTransactionStatus.PROCESSING,
    });
  });

  it("returns payout summary grouped by status", async () => {
    databaseServiceMock.payoutTransaction.groupBy.mockResolvedValueOnce([
      {
        status: PayoutTransactionStatus.PAID_OUT,
        _count: { _all: 2 },
        _sum: { amountToPay: asDecimal(80000), amountPaid: asDecimal(78000) },
      },
      {
        status: PayoutTransactionStatus.PENDING_DISBURSEMENT,
        _count: { _all: 1 },
        _sum: { amountToPay: asDecimal(45000), amountPaid: null },
      },
      {
        status: PayoutTransactionStatus.FAILED,
        _count: { _all: 1 },
        _sum: { amountToPay: asDecimal(20000), amountPaid: null },
      },
    ]);
    databaseServiceMock.payoutTransaction.aggregate.mockResolvedValueOnce({
      _max: { completedAt: new Date("2026-02-01T00:00:00.000Z") },
    });

    const result = await service.getPayoutSummary("owner-1");

    expect(result.totalPaidOut).toBe(78000);
    expect(result.pendingPayouts).toBe(45000);
    expect(result.failedPayouts).toBe(20000);
    expect(result.statusBreakdown[PayoutTransactionStatus.PAID_OUT].count).toBe(2);
  });
});
