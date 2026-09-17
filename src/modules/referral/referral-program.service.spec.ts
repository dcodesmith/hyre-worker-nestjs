import { Test, type TestingModule } from "@nestjs/testing";
import {
  BookingType,
  Prisma,
  ReferralIncentiveType,
  ReferralProgramAuditAction,
  ReferralProgramStatus,
} from "@prisma/client";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createReferralProgram } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import type { CreateReferralProgramDto } from "./dto/referral-program.dto";
import {
  ReferralProgramAlreadyExistsException,
  ReferralProgramNotFoundException,
} from "./referral.error";
import { ReferralProgramService } from "./referral-program.service";

const ACTOR_ID = "admin-1";

const uniqueConstraintError = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });

const createDto: CreateReferralProgramDto = {
  refereeDiscount: { type: ReferralIncentiveType.FIXED, amount: 10000 },
  referrerReward: { type: ReferralIncentiveType.FIXED, amount: 2500 },
  minimumBookingAmount: 20000,
  eligibleBookingTypes: [BookingType.DAY, BookingType.FULL_DAY],
  referralValidityDays: 30,
  maxCreditsPerBookingAmount: 30000,
  maxCreditsPerBookingPercent: 50,
};

describe("ReferralProgramService", () => {
  let service: ReferralProgramService;
  const transactionClient = {
    $queryRaw: vi.fn(),
    referralProgram: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    referralProgramAudit: {
      create: vi.fn(),
    },
  };
  const databaseService = {
    $transaction: vi.fn((callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    referralProgram: {
      findUnique: vi.fn(),
    },
    referralProgramAudit: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReferralProgramService, { provide: DatabaseService, useValue: databaseService }],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(ReferralProgramService);
  });

  describe("create", () => {
    it("atomically writes the active singleton and a CREATED audit row", async () => {
      const program = createReferralProgram({
        refereeDiscountValue: new Decimal(10000),
        referrerRewardValue: new Decimal(2500),
        minimumBookingAmount: new Decimal(20000),
        maxCreditsPerBookingAmount: new Decimal(30000),
        maxCreditsPerBookingPercent: new Decimal(50),
      });
      transactionClient.referralProgram.create.mockResolvedValue(program);
      transactionClient.referralProgramAudit.create.mockResolvedValue({});

      const result = await service.create(createDto, ACTOR_ID);

      expect(databaseService.$transaction).toHaveBeenCalledOnce();
      expect(transactionClient.referralProgram.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: "default",
          status: ReferralProgramStatus.ACTIVE,
          refereeDiscountType: ReferralIncentiveType.FIXED,
          refereeDiscountValue: 10000,
          refereeDiscountMaxAmount: null,
          referrerRewardType: ReferralIncentiveType.FIXED,
          referrerRewardValue: 2500,
          referrerRewardMaxAmount: null,
          createdById: ACTOR_ID,
          updatedById: ACTOR_ID,
        }),
      });
      expect(transactionClient.referralProgramAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: ReferralProgramAuditAction.CREATED,
          actorId: ACTOR_ID,
          after: expect.objectContaining({
            id: "default",
            status: ReferralProgramStatus.ACTIVE,
          }),
        }),
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: "default",
          status: ReferralProgramStatus.ACTIVE,
          refereeDiscount: { type: ReferralIncentiveType.FIXED, amount: 10000 },
          referrerReward: { type: ReferralIncentiveType.FIXED, amount: 2500 },
        }),
      );
    });

    it("maps a unique constraint to a 409 already-exists exception", async () => {
      databaseService.$transaction.mockRejectedValueOnce(uniqueConstraintError());

      await expect(service.create(createDto, ACTOR_ID)).rejects.toBeInstanceOf(
        ReferralProgramAlreadyExistsException,
      );
    });
  });

  describe("get", () => {
    it("returns the configured programme", async () => {
      const program = createReferralProgram();
      databaseService.referralProgram.findUnique.mockResolvedValue(program);

      await expect(service.get()).resolves.toEqual(
        expect.objectContaining({
          id: "default",
          refereeDiscount: { type: ReferralIncentiveType.FIXED, amount: 5000 },
        }),
      );
    });

    it("throws not-found when the singleton is missing", async () => {
      databaseService.referralProgram.findUnique.mockResolvedValue(null);

      await expect(service.get()).rejects.toBeInstanceOf(ReferralProgramNotFoundException);
    });
  });

  describe("update", () => {
    it("throws not-found when the locked row is missing", async () => {
      transactionClient.referralProgram.findUnique.mockResolvedValue(null);

      await expect(
        service.update({ minimumBookingAmount: 25000 }, ACTOR_ID),
      ).rejects.toBeInstanceOf(ReferralProgramNotFoundException);
    });

    it("writes a STATUS_CHANGED audit when status actually changes", async () => {
      const current = createReferralProgram({ status: ReferralProgramStatus.ACTIVE });
      const updated = createReferralProgram({ status: ReferralProgramStatus.PAUSED });
      transactionClient.referralProgram.findUnique.mockResolvedValue(current);
      transactionClient.referralProgram.update.mockResolvedValue(updated);
      transactionClient.referralProgramAudit.create.mockResolvedValue({});

      const result = await service.update({ status: ReferralProgramStatus.PAUSED }, ACTOR_ID);

      expect(result.status).toBe(ReferralProgramStatus.PAUSED);
      expect(transactionClient.referralProgramAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: ReferralProgramAuditAction.STATUS_CHANGED,
          actorId: ACTOR_ID,
        }),
      });
    });

    it("writes an UPDATED audit when values change without a status transition", async () => {
      const current = createReferralProgram();
      const updated = createReferralProgram({ minimumBookingAmount: new Decimal(25000) });
      transactionClient.referralProgram.findUnique.mockResolvedValue(current);
      transactionClient.referralProgram.update.mockResolvedValue(updated);
      transactionClient.referralProgramAudit.create.mockResolvedValue({});

      await service.update({ minimumBookingAmount: 25000 }, ACTOR_ID);

      expect(transactionClient.referralProgramAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: ReferralProgramAuditAction.UPDATED,
          actorId: ACTOR_ID,
        }),
      });
    });
  });

  describe("history", () => {
    it("paginates audit rows newest first", async () => {
      const items = [{ id: "audit-2" }, { id: "audit-1" }];
      databaseService.referralProgramAudit.findMany.mockResolvedValue(items);
      databaseService.referralProgramAudit.count.mockResolvedValue(45);

      await expect(service.history({ page: 2, pageSize: 20 })).resolves.toEqual({
        data: items,
        pagination: {
          page: 2,
          pageSize: 20,
          totalItems: 45,
          totalPages: 3,
        },
      });
      expect(databaseService.referralProgramAudit.findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: "desc" },
        skip: 20,
        take: 20,
      });
    });
  });

  describe("calculations", () => {
    it("uses a FIXED incentive as-is and never exceeds the booking base", () => {
      const program = createReferralProgram({
        refereeDiscountType: ReferralIncentiveType.FIXED,
        refereeDiscountValue: new Decimal(7500),
        referrerRewardType: ReferralIncentiveType.FIXED,
        referrerRewardValue: new Decimal(40000),
      });

      expect(service.calculateRefereeDiscount(program, new Decimal(20000)).toString()).toBe("7500");
      expect(service.calculateReferrerReward(program, new Decimal(20000)).toString()).toBe("20000");
    });

    it("rounds PERCENTAGE incentives half-up and applies the max-amount cap", () => {
      const program = createReferralProgram({
        refereeDiscountType: ReferralIncentiveType.PERCENTAGE,
        refereeDiscountValue: new Decimal("10.00"),
        refereeDiscountMaxAmount: new Decimal(4000),
        referrerRewardType: ReferralIncentiveType.PERCENTAGE,
        referrerRewardValue: new Decimal("15.00"),
        referrerRewardMaxAmount: new Decimal(10000),
      });

      // 10% of 33333.33 = 3333.333 → 3333.33, under the 4000 cap
      expect(service.calculateRefereeDiscount(program, new Decimal("33333.33")).toString()).toBe(
        "3333.33",
      );
      // 10% of 50000 = 5000, capped at 4000
      expect(service.calculateRefereeDiscount(program, new Decimal(50000)).toString()).toBe("4000");
      // 15% of 100.05 = 15.0075 → 15.01
      expect(service.calculateReferrerReward(program, new Decimal("100.05")).toString()).toBe(
        "15.01",
      );
    });

    it("caps credits at the lower of the amount and percentage limits", () => {
      const program = createReferralProgram({
        maxCreditsPerBookingAmount: new Decimal(30000),
        maxCreditsPerBookingPercent: new Decimal(50),
      });

      expect(service.calculateCreditsCap(program, new Decimal(100000)).toString()).toBe("30000");
      expect(service.calculateCreditsCap(program, new Decimal(40000)).toString()).toBe("20000");
      // 12.5% of 333.33 with amount cap 50 → 41.66625 → 41.67
      expect(
        service
          .calculateCreditsCap(
            createReferralProgram({
              maxCreditsPerBookingAmount: new Decimal(50),
              maxCreditsPerBookingPercent: new Decimal("12.50"),
            }),
            new Decimal("333.33"),
          )
          .toString(),
      ).toBe("41.67");
    });
  });
});
