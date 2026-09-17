import { Injectable } from "@nestjs/common";
import {
  Prisma,
  ReferralIncentiveType,
  type ReferralProgram,
  ReferralProgramAuditAction,
  ReferralProgramStatus,
} from "@prisma/client";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService, isUniqueConstraintError } from "../database/database.service";
import type {
  CreateReferralProgramDto,
  ReferralProgramHistoryQueryDto,
  UpdateReferralProgramDto,
} from "./dto/referral-program.dto";
import {
  ReferralProgramAlreadyExistsException,
  ReferralProgramNotFoundException,
} from "./referral.error";

const REFERRAL_PROGRAM_ID = "default";

type ReferralProgramReader = Pick<Prisma.TransactionClient, "referralProgram">;
type ReferralProgramValuesData = Pick<
  Prisma.ReferralProgramUncheckedCreateInput,
  | "refereeDiscountType"
  | "refereeDiscountValue"
  | "refereeDiscountMaxAmount"
  | "referrerRewardType"
  | "referrerRewardValue"
  | "referrerRewardMaxAmount"
  | "minimumBookingAmount"
  | "eligibleBookingTypes"
  | "referralValidityDays"
  | "maxCreditsPerBookingAmount"
  | "maxCreditsPerBookingPercent"
>;

@Injectable()
export class ReferralProgramService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReferralProgramService.name);
  }

  async create(dto: CreateReferralProgramDto, actorId: string) {
    try {
      const program = await this.databaseService.$transaction(async (tx) => {
        const created = await tx.referralProgram.create({
          data: {
            id: REFERRAL_PROGRAM_ID,
            status: ReferralProgramStatus.ACTIVE,
            ...this.valuesToData(dto),
            createdById: actorId,
            updatedById: actorId,
          },
        });
        await tx.referralProgramAudit.create({
          data: {
            action: ReferralProgramAuditAction.CREATED,
            after: this.toAuditSnapshot(created),
            actorId,
          },
        });
        return created;
      });

      this.logger.info({ actorId, status: program.status }, "Referral programme created");
      return this.toResponse(program);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ReferralProgramAlreadyExistsException();
      }
      throw error;
    }
  }

  async get() {
    return this.toResponse(await this.getOrThrow());
  }

  async update(dto: UpdateReferralProgramDto, actorId: string) {
    const updated = await this.databaseService.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "ReferralProgram" WHERE "id" = ${REFERRAL_PROGRAM_ID} FOR UPDATE`,
      );
      const current = await tx.referralProgram.findUnique({
        where: { id: REFERRAL_PROGRAM_ID },
      });
      if (!current) {
        throw new ReferralProgramNotFoundException();
      }

      const program = await tx.referralProgram.update({
        where: { id: REFERRAL_PROGRAM_ID },
        data: {
          ...(dto.status ? { status: dto.status } : {}),
          ...this.valuesToData(dto),
          updatedById: actorId,
        },
      });

      await tx.referralProgramAudit.create({
        data: {
          action:
            dto.status && dto.status !== current.status
              ? ReferralProgramAuditAction.STATUS_CHANGED
              : ReferralProgramAuditAction.UPDATED,
          before: this.toAuditSnapshot(current),
          after: this.toAuditSnapshot(program),
          actorId,
        },
      });
      return program;
    });

    this.logger.info(
      { actorId, status: updated.status, changedFields: Object.keys(dto) },
      "Referral programme updated",
    );
    return this.toResponse(updated);
  }

  async history(query: ReferralProgramHistoryQueryDto) {
    const skip = (query.page - 1) * query.pageSize;
    const [items, totalItems] = await Promise.all([
      this.databaseService.referralProgramAudit.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: query.pageSize,
      }),
      this.databaseService.referralProgramAudit.count(),
    ]);

    return {
      data: items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }

  getProgram(
    reader: ReferralProgramReader = this.databaseService,
  ): Promise<ReferralProgram | null> {
    return reader.referralProgram.findUnique({
      where: { id: REFERRAL_PROGRAM_ID },
    });
  }

  async getActiveProgram(
    reader: ReferralProgramReader = this.databaseService,
  ): Promise<ReferralProgram | null> {
    const program = await this.getProgram(reader);
    return program?.status === ReferralProgramStatus.ACTIVE ? program : null;
  }

  async getActiveProgramForTransaction(
    tx: Prisma.TransactionClient,
  ): Promise<ReferralProgram | null> {
    const program = await this.getProgramForTransaction(tx);
    return program?.status === ReferralProgramStatus.ACTIVE ? program : null;
  }

  async getProgramForTransaction(tx: Prisma.TransactionClient): Promise<ReferralProgram | null> {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ReferralProgram" WHERE "id" = ${REFERRAL_PROGRAM_ID} FOR SHARE`,
    );
    return this.getProgram(tx);
  }

  calculateRefereeDiscount(program: ReferralProgram, bookingBase: Decimal): Decimal {
    return this.calculateIncentive(
      program.refereeDiscountType,
      program.refereeDiscountValue,
      program.refereeDiscountMaxAmount,
      bookingBase,
    );
  }

  calculateReferrerReward(program: ReferralProgram, bookingBase: Decimal): Decimal {
    return this.calculateIncentive(
      program.referrerRewardType,
      program.referrerRewardValue,
      program.referrerRewardMaxAmount,
      bookingBase,
    );
  }

  calculateCreditsCap(program: ReferralProgram, bookingBase: Decimal): Decimal {
    const percentageCap = bookingBase.mul(program.maxCreditsPerBookingPercent).div(100);
    return Decimal.min(program.maxCreditsPerBookingAmount, percentageCap).toDecimalPlaces(
      2,
      Decimal.ROUND_HALF_UP,
    );
  }

  private async getOrThrow(): Promise<ReferralProgram> {
    const program = await this.getProgram();
    if (!program) {
      throw new ReferralProgramNotFoundException();
    }
    return program;
  }

  private calculateIncentive(
    type: ReferralIncentiveType,
    value: Decimal,
    maxAmount: Decimal | null,
    bookingBase: Decimal,
  ): Decimal {
    const calculated =
      type === ReferralIncentiveType.FIXED
        ? value
        : Decimal.min(bookingBase.mul(value).div(100), maxAmount as Decimal);
    return Decimal.min(bookingBase, calculated).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  private valuesToData(dto: CreateReferralProgramDto): ReferralProgramValuesData;
  private valuesToData(dto: UpdateReferralProgramDto): Partial<ReferralProgramValuesData>;
  private valuesToData(
    dto: Partial<CreateReferralProgramDto | UpdateReferralProgramDto>,
  ): Partial<ReferralProgramValuesData> {
    return {
      ...(dto.refereeDiscount
        ? {
            refereeDiscountType: dto.refereeDiscount.type,
            refereeDiscountValue:
              dto.refereeDiscount.type === ReferralIncentiveType.FIXED
                ? dto.refereeDiscount.amount
                : dto.refereeDiscount.percentage,
            refereeDiscountMaxAmount:
              dto.refereeDiscount.type === ReferralIncentiveType.PERCENTAGE
                ? dto.refereeDiscount.maxAmount
                : null,
          }
        : {}),
      ...(dto.referrerReward
        ? {
            referrerRewardType: dto.referrerReward.type,
            referrerRewardValue:
              dto.referrerReward.type === ReferralIncentiveType.FIXED
                ? dto.referrerReward.amount
                : dto.referrerReward.percentage,
            referrerRewardMaxAmount:
              dto.referrerReward.type === ReferralIncentiveType.PERCENTAGE
                ? dto.referrerReward.maxAmount
                : null,
          }
        : {}),
      ...(dto.minimumBookingAmount !== undefined
        ? { minimumBookingAmount: dto.minimumBookingAmount }
        : {}),
      ...(dto.eligibleBookingTypes ? { eligibleBookingTypes: dto.eligibleBookingTypes } : {}),
      ...(dto.referralValidityDays !== undefined
        ? { referralValidityDays: dto.referralValidityDays }
        : {}),
      ...(dto.maxCreditsPerBookingAmount !== undefined
        ? { maxCreditsPerBookingAmount: dto.maxCreditsPerBookingAmount }
        : {}),
      ...(dto.maxCreditsPerBookingPercent !== undefined
        ? { maxCreditsPerBookingPercent: dto.maxCreditsPerBookingPercent }
        : {}),
    };
  }

  private toResponse(program: ReferralProgram) {
    return {
      id: program.id,
      status: program.status,
      refereeDiscount:
        program.refereeDiscountType === ReferralIncentiveType.FIXED
          ? {
              type: ReferralIncentiveType.FIXED,
              amount: program.refereeDiscountValue.toNumber(),
            }
          : {
              type: ReferralIncentiveType.PERCENTAGE,
              percentage: program.refereeDiscountValue.toNumber(),
              maxAmount: program.refereeDiscountMaxAmount?.toNumber(),
            },
      referrerReward:
        program.referrerRewardType === ReferralIncentiveType.FIXED
          ? {
              type: ReferralIncentiveType.FIXED,
              amount: program.referrerRewardValue.toNumber(),
            }
          : {
              type: ReferralIncentiveType.PERCENTAGE,
              percentage: program.referrerRewardValue.toNumber(),
              maxAmount: program.referrerRewardMaxAmount?.toNumber(),
            },
      minimumBookingAmount: program.minimumBookingAmount.toNumber(),
      eligibleBookingTypes: program.eligibleBookingTypes,
      referralValidityDays: program.referralValidityDays,
      maxCreditsPerBookingAmount: program.maxCreditsPerBookingAmount.toNumber(),
      maxCreditsPerBookingPercent: program.maxCreditsPerBookingPercent.toNumber(),
      createdAt: program.createdAt,
      updatedAt: program.updatedAt,
      createdById: program.createdById,
      updatedById: program.updatedById,
    };
  }

  private toAuditSnapshot(program: ReferralProgram): Prisma.InputJsonObject {
    const response = this.toResponse(program);
    return {
      ...response,
      createdAt: response.createdAt.toISOString(),
      updatedAt: response.updatedAt.toISOString(),
    };
  }
}
