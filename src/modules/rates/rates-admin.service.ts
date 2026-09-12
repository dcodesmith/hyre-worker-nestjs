import { Injectable } from "@nestjs/common";
import type { PlatformFeeType } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import type { CreatePlatformFeeDto, CreateVatRateDto } from "./dto/rates-admin.dto";
import {
  RateCreateFailedException,
  RateDateOverlapException,
  RatesException,
  RatesFetchFailedException,
} from "./rates.error";
import { buildOverlapWindowWhere, isRateActive } from "./rates.helper";
import { RatesService } from "./rates.service";

@Injectable()
export class RatesAdminService {
  private readonly serializableIsolationLevel = "Serializable" as const;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly ratesService: RatesService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RatesAdminService.name);
  }

  async getAllRates() {
    try {
      const [platformFeeRates, taxRates] = await Promise.all([
        this.databaseService.platformFeeRate.findMany({
          orderBy: [{ feeType: "asc" }, { effectiveSince: "desc" }],
        }),
        this.databaseService.taxRate.findMany({
          orderBy: { effectiveSince: "desc" },
        }),
      ]);

      const now = new Date();

      return {
        platformFeeRates: platformFeeRates.map((rate) => ({
          ...rate,
          ratePercent: rate.ratePercent.toNumber(),
          active: isRateActive(rate, now),
        })),
        taxRates: taxRates.map((rate) => ({
          ...rate,
          ratePercent: rate.ratePercent.toNumber(),
          active: isRateActive(rate, now),
        })),
      };
    } catch (error) {
      if (error instanceof RatesException) {
        throw error;
      }
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to get all rates",
      );
      throw new RatesFetchFailedException();
    }
  }

  async createPlatformFeeRate(dto: CreatePlatformFeeDto) {
    try {
      const rate = await this.databaseService.$transaction(
        async (tx) => {
          await this.assertNoPlatformFeeOverlap(
            dto.feeType,
            dto.effectiveSince,
            dto.effectiveUntil,
            tx,
          );

          return tx.platformFeeRate.create({
            data: {
              feeType: dto.feeType,
              ratePercent: dto.ratePercent,
              effectiveSince: dto.effectiveSince,
              effectiveUntil: dto.effectiveUntil,
              description: dto.description,
            },
          });
        },
        { isolationLevel: this.serializableIsolationLevel },
      );

      this.ratesService.clearCache();
      return { ...rate, ratePercent: rate.ratePercent.toNumber() };
    } catch (error) {
      if (error instanceof RatesException) {
        throw error;
      }
      this.logger.error(
        {
          dto,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to create platform fee rate",
      );
      throw new RateCreateFailedException();
    }
  }

  async createVatRate(dto: CreateVatRateDto) {
    try {
      const rate = await this.databaseService.$transaction(
        async (tx) => {
          await this.assertNoVatRateOverlap(dto.effectiveSince, dto.effectiveUntil, tx);

          return tx.taxRate.create({
            data: {
              ratePercent: dto.ratePercent,
              effectiveSince: dto.effectiveSince,
              effectiveUntil: dto.effectiveUntil,
              description: dto.description,
            },
          });
        },
        { isolationLevel: this.serializableIsolationLevel },
      );

      this.ratesService.clearCache();
      return { ...rate, ratePercent: rate.ratePercent.toNumber() };
    } catch (error) {
      if (error instanceof RatesException) {
        throw error;
      }
      this.logger.error(
        {
          dto,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to create VAT rate",
      );
      throw new RateCreateFailedException();
    }
  }

  private async assertNoPlatformFeeOverlap(
    feeType: PlatformFeeType,
    effectiveSince: Date,
    effectiveUntil?: Date,
    tx: Pick<DatabaseService, "platformFeeRate"> = this.databaseService,
  ): Promise<void> {
    const overlapping = await tx.platformFeeRate.findFirst({
      where: {
        feeType,
        ...buildOverlapWindowWhere(effectiveSince, effectiveUntil),
      },
    });

    if (overlapping) {
      throw new RateDateOverlapException(
        `A ${feeType} rate already exists that overlaps with this date range`,
      );
    }
  }

  private async assertNoVatRateOverlap(
    effectiveSince: Date,
    effectiveUntil?: Date,
    tx: Pick<DatabaseService, "taxRate"> = this.databaseService,
  ): Promise<void> {
    const overlapping = await tx.taxRate.findFirst({
      where: {
        ...buildOverlapWindowWhere(effectiveSince, effectiveUntil),
      },
    });

    if (overlapping) {
      throw new RateDateOverlapException(
        "A VAT rate already exists that overlaps with this date range",
      );
    }
  }
}
