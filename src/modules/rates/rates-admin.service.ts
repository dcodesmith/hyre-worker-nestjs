import { Injectable, Logger } from "@nestjs/common";
import type { AddonType, PlatformFeeType } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import type {
  CreateAddonRateDto,
  CreatePlatformFeeDto,
  CreateVatRateDto,
} from "./dto/rates-admin.dto";
import {
  RateAlreadyEndedException,
  RateCreateFailedException,
  RateDateOverlapException,
  RateNotFoundException,
  RateNotYetActiveException,
  RatesException,
  RatesFetchFailedException,
  RateUpdateFailedException,
} from "./rates.error";
import { buildOverlapWindowWhere, isRateActive } from "./rates.helper";
import { RatesService } from "./rates.service";

@Injectable()
export class RatesAdminService {
  private readonly logger = new Logger(RatesAdminService.name);
  private readonly serializableIsolationLevel = "Serializable" as const;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly ratesService: RatesService,
  ) {}

  async getAllRates() {
    try {
      const [platformFeeRates, taxRates, addonRates] = await Promise.all([
        this.databaseService.platformFeeRate.findMany({
          orderBy: [{ feeType: "asc" }, { effectiveSince: "desc" }],
        }),
        this.databaseService.taxRate.findMany({
          orderBy: { effectiveSince: "desc" },
        }),
        this.databaseService.addonRate.findMany({
          orderBy: [{ addonType: "asc" }, { effectiveSince: "desc" }],
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
        addonRates: addonRates.map((rate) => ({
          ...rate,
          rateAmount: rate.rateAmount.toNumber(),
          active: isRateActive(rate, now),
        })),
      };
    } catch (error) {
      if (error instanceof RatesException) {
        throw error;
      }
      this.logger.error("Failed to get all rates", {
        error: error instanceof Error ? error.message : String(error),
      });
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
      this.logger.error("Failed to create platform fee rate", {
        dto,
        error: error instanceof Error ? error.message : String(error),
      });
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
      this.logger.error("Failed to create VAT rate", {
        dto,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new RateCreateFailedException();
    }
  }

  async createAddonRate(dto: CreateAddonRateDto) {
    try {
      const rate = await this.databaseService.$transaction(
        async (tx) => {
          await this.assertNoAddonRateOverlap(
            dto.addonType,
            dto.effectiveSince,
            dto.effectiveUntil,
            tx,
          );

          return tx.addonRate.create({
            data: {
              addonType: dto.addonType,
              rateAmount: dto.rateAmount,
              effectiveSince: dto.effectiveSince,
              effectiveUntil: dto.effectiveUntil,
              description: dto.description,
            },
          });
        },
        { isolationLevel: this.serializableIsolationLevel },
      );

      this.ratesService.clearCache();
      return { ...rate, rateAmount: rate.rateAmount.toNumber() };
    } catch (error) {
      if (error instanceof RatesException) {
        throw error;
      }
      this.logger.error("Failed to create addon rate", {
        dto,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new RateCreateFailedException();
    }
  }

  async endAddonRate(addonRateId: string) {
    try {
      const now = new Date();
      const rate = await this.databaseService.$transaction(
        async (tx) => {
          const existing = await tx.addonRate.findUnique({
            where: { id: addonRateId },
          });

          if (!existing) {
            throw new RateNotFoundException();
          }

          if (existing.effectiveUntil !== null) {
            throw new RateAlreadyEndedException();
          }

          if (existing.effectiveSince > now) {
            throw new RateNotYetActiveException();
          }

          return tx.addonRate.update({
            where: { id: addonRateId },
            data: { effectiveUntil: now },
          });
        },
        { isolationLevel: this.serializableIsolationLevel },
      );

      this.ratesService.clearCache();
      return { ...rate, rateAmount: rate.rateAmount.toNumber() };
    } catch (error) {
      if (error instanceof RatesException) {
        throw error;
      }
      this.logger.error("Failed to end addon rate", {
        addonRateId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new RateUpdateFailedException();
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

  private async assertNoAddonRateOverlap(
    addonType: AddonType,
    effectiveSince: Date,
    effectiveUntil?: Date,
    tx: Pick<DatabaseService, "addonRate"> = this.databaseService,
  ): Promise<void> {
    const overlapping = await tx.addonRate.findFirst({
      where: {
        addonType,
        ...buildOverlapWindowWhere(effectiveSince, effectiveUntil),
      },
    });

    if (overlapping) {
      throw new RateDateOverlapException(
        `A ${addonType} addon rate already exists that overlaps with this date range`,
      );
    }
  }
}
