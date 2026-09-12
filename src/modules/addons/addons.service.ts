import { Injectable } from "@nestjs/common";
import type { Addon, BookingType, Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import {
  DatabaseService,
  isRecordNotFoundError,
  isUniqueConstraintError,
} from "../database/database.service";
import { buildActiveWindowWhere, buildOverlapWindowWhere } from "../rates/rates.helper";
import {
  AddonCodeConflictException,
  AddonNotFoundException,
  AddonPriceCannotEndException,
  AddonPriceNotFoundException,
  AddonPriceOverlapException,
  InvalidBookingAddonsException,
} from "./addons.error";
import type {
  AdminAddonPrice,
  AdminAddonsResponse,
  PublicAddonsResponse,
  ResolvedBookingAddon,
} from "./addons.interface";
import type { CreateAddonDto, CreateAddonPriceDto, UpdateAddonDto } from "./dto/addons.dto";

@Injectable()
export class AddonsService {
  constructor(private readonly databaseService: DatabaseService) {}

  async listPublic(bookingType: BookingType): Promise<PublicAddonsResponse> {
    const now = new Date();
    const addons = await this.databaseService.addon.findMany({
      where: {
        isActive: true,
        bookingTypes: { has: bookingType },
      },
      include: {
        prices: {
          where: buildActiveWindowWhere(now),
          orderBy: { effectiveSince: "desc" },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    });

    return {
      addons: addons.flatMap((addon) => {
        const price = addon.prices[0];
        return price
          ? [
              {
                id: addon.id,
                code: addon.code,
                name: addon.name,
                description: addon.description,
                pricingUnit: addon.pricingUnit,
                unitPrice: price.amount.toNumber(),
                currency: "NGN" as const,
              },
            ]
          : [];
      }),
    };
  }

  async listAdmin(): Promise<AdminAddonsResponse> {
    const addons = await this.databaseService.addon.findMany({
      include: {
        prices: {
          orderBy: { effectiveSince: "desc" },
        },
      },
      orderBy: { name: "asc" },
    });

    return {
      addons: addons.map((addon) => ({
        ...addon,
        prices: addon.prices.map((price) => ({
          ...price,
          amount: price.amount.toNumber(),
        })),
      })),
    };
  }

  async create(dto: CreateAddonDto, actorId: string): Promise<Addon> {
    try {
      return await this.databaseService.addon.create({
        data: {
          ...dto,
          description: dto.description ?? null,
          createdById: actorId,
          updatedById: actorId,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AddonCodeConflictException();
      }
      throw error;
    }
  }

  async update(addonId: string, dto: UpdateAddonDto, actorId: string): Promise<Addon> {
    try {
      return await this.databaseService.addon.update({
        where: { id: addonId },
        data: {
          ...dto,
          updatedById: actorId,
        },
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw new AddonNotFoundException();
      }
      throw error;
    }
  }

  async createPrice(
    addonId: string,
    dto: CreateAddonPriceDto,
    actorId: string,
  ): Promise<AdminAddonPrice> {
    return this.databaseService.$transaction(
      async (tx) => {
        const addon = await tx.addon.findUnique({
          where: { id: addonId },
          select: { id: true },
        });
        if (!addon) {
          throw new AddonNotFoundException();
        }

        const overlap = await tx.addonPrice.findFirst({
          where: {
            addonId,
            ...buildOverlapWindowWhere(dto.effectiveSince, dto.effectiveUntil),
          },
          select: { id: true },
        });
        if (overlap) {
          throw new AddonPriceOverlapException();
        }

        const price = await tx.addonPrice.create({
          data: {
            addonId,
            amount: dto.amount,
            effectiveSince: dto.effectiveSince,
            effectiveUntil: dto.effectiveUntil ?? null,
            createdById: actorId,
            updatedById: actorId,
          },
        });
        return { ...price, amount: price.amount.toNumber() };
      },
      { isolationLevel: "Serializable" },
    );
  }

  async endPrice(addonId: string, priceId: string, actorId: string): Promise<AdminAddonPrice> {
    return this.databaseService.$transaction(
      async (tx) => {
        const price = await tx.addonPrice.findUnique({
          where: { id: priceId },
        });
        if (!price || price.addonId !== addonId) {
          throw new AddonPriceNotFoundException();
        }
        if (price.effectiveUntil) {
          throw new AddonPriceCannotEndException("This add-on price has already ended");
        }

        const now = new Date();
        if (price.effectiveSince > now) {
          throw new AddonPriceCannotEndException("A future add-on price cannot be ended");
        }

        const updated = await tx.addonPrice.update({
          where: { id: priceId },
          data: { effectiveUntil: now, updatedById: actorId },
        });
        return { ...updated, amount: updated.amount.toNumber() };
      },
      { isolationLevel: "Serializable" },
    );
  }

  async resolveBookingAddons(
    addonIds: string[],
    bookingType: BookingType,
    numberOfLegs: number,
    tx?: Prisma.TransactionClient,
  ): Promise<ResolvedBookingAddon[]> {
    if (addonIds.length === 0) {
      return [];
    }
    if (new Set(addonIds).size !== addonIds.length) {
      throw new InvalidBookingAddonsException();
    }

    const now = new Date();
    const reader = tx ?? this.databaseService;
    const addons = await reader.addon.findMany({
      where: {
        id: { in: addonIds },
        isActive: true,
        bookingTypes: { has: bookingType },
      },
      include: {
        prices: {
          where: buildActiveWindowWhere(now),
          orderBy: { effectiveSince: "desc" },
          take: 1,
        },
      },
    });

    if (addons.length !== addonIds.length || addons.some((addon) => !addon.prices[0])) {
      throw new InvalidBookingAddonsException();
    }

    return addons
      .map((addon) => {
        const unitPrice = new Decimal(addon.prices[0].amount.toString());
        const quantity = addon.pricingUnit === "PER_LEG" ? numberOfLegs : 1;
        return {
          id: addon.id,
          code: addon.code,
          name: addon.name,
          pricingUnit: addon.pricingUnit,
          financialTreatment: addon.financialTreatment,
          unitPrice,
          quantity,
          totalPrice: unitPrice.mul(quantity),
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));
  }
}
