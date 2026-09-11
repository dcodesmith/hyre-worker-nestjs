import { Test, type TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { buildActiveWindowWhere } from "../rates/rates.helper";
import {
  AddonCodeConflictException,
  AddonNotFoundException,
  AddonPriceCannotEndException,
  AddonPriceNotFoundException,
  AddonPriceOverlapException,
  InvalidBookingAddonsException,
} from "./addons.error";
import { AddonsService } from "./addons.service";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const ACTOR_ID = "user-admin-1";

const uniqueConstraintError = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });

const recordNotFoundError = () =>
  new Prisma.PrismaClientKnownRequestError("Record not found", {
    code: "P2025",
    clientVersion: "test",
  });

function catalogAddon(
  overrides: {
    id?: string;
    code?: string;
    name?: string;
    description?: string | null;
    bookingTypes?: Array<"DAY" | "NIGHT" | "FULL_DAY" | "AIRPORT_PICKUP">;
    pricingUnit?: "PER_BOOKING" | "PER_LEG";
    financialTreatment?: "PLATFORM" | "FLEET_OWNER";
    amount?: number | null;
  } = {},
) {
  const amount = overrides.amount === null ? undefined : (overrides.amount ?? 10000);
  return {
    id: overrides.id ?? "addon-1",
    code: overrides.code ?? "WIFI_HOTSPOT",
    name: overrides.name ?? "Wi-Fi Hotspot",
    description: overrides.description ?? "Onboard hotspot",
    bookingTypes: overrides.bookingTypes ?? ["DAY"],
    pricingUnit: overrides.pricingUnit ?? "PER_BOOKING",
    financialTreatment: overrides.financialTreatment ?? "PLATFORM",
    isActive: true,
    prices:
      amount === undefined
        ? []
        : [
            {
              id: `${overrides.id ?? "addon-1"}-price`,
              amount: new Decimal(amount),
              effectiveSince: new Date("2020-01-01"),
              effectiveUntil: null,
            },
          ],
  };
}

describe("AddonsService", () => {
  let service: AddonsService;
  let databaseService: {
    $transaction: ReturnType<typeof vi.fn>;
    addon: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    addonPrice: {
      findFirst: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    databaseService = {
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(databaseService)),
      addon: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      addonPrice: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AddonsService, { provide: DatabaseService, useValue: databaseService }],
    }).compile();

    service = module.get(AddonsService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("listPublic", () => {
    it("returns only active add-ons that apply to the booking type and have a current price", async () => {
      databaseService.addon.findMany.mockResolvedValue([
        catalogAddon({ id: "wifi", code: "WIFI_HOTSPOT", name: "Wi-Fi Hotspot", amount: 8000 }),
        catalogAddon({ id: "no-price", code: "CHILD_SEAT", name: "Child Seat", amount: null }),
      ]);

      const result = await service.listPublic("DAY");

      expect(databaseService.addon.findMany).toHaveBeenCalledWith({
        where: {
          isActive: true,
          bookingTypes: { has: "DAY" },
        },
        include: {
          prices: {
            where: buildActiveWindowWhere(NOW),
            orderBy: { effectiveSince: "desc" },
            take: 1,
          },
        },
        orderBy: { name: "asc" },
      });
      expect(result).toEqual({
        addons: [
          {
            id: "wifi",
            code: "WIFI_HOTSPOT",
            name: "Wi-Fi Hotspot",
            description: "Onboard hotspot",
            pricingUnit: "PER_BOOKING",
            unitPrice: 8000,
            currency: "NGN",
          },
        ],
      });
    });
  });

  describe("listAdmin", () => {
    it("maps every catalog row and price amount to numbers", async () => {
      const createdAt = new Date("2026-01-01");
      databaseService.addon.findMany.mockResolvedValue([
        {
          ...catalogAddon(),
          createdById: ACTOR_ID,
          updatedById: ACTOR_ID,
          createdAt,
          updatedAt: createdAt,
          prices: [
            {
              id: "price-1",
              addonId: "addon-1",
              amount: new Decimal("15000.50"),
              effectiveSince: new Date("2020-01-01"),
              effectiveUntil: null,
              createdById: ACTOR_ID,
              updatedById: ACTOR_ID,
              createdAt,
              updatedAt: createdAt,
            },
          ],
        },
      ]);

      const result = await service.listAdmin();

      expect(result.addons[0]?.prices[0]?.amount).toBe(15000.5);
      expect(databaseService.addon.findMany).toHaveBeenCalledWith({
        include: {
          prices: {
            orderBy: { effectiveSince: "desc" },
          },
        },
        orderBy: { name: "asc" },
      });
    });
  });

  describe("create", () => {
    it("persists the add-on with the acting user as creator", async () => {
      const dto = {
        code: "WIFI_HOTSPOT",
        name: "Wi-Fi Hotspot",
        bookingTypes: ["DAY" as const],
        pricingUnit: "PER_BOOKING" as const,
        financialTreatment: "PLATFORM" as const,
        isActive: true,
      };
      const created = { id: "addon-1", ...dto, description: null };
      databaseService.addon.create.mockResolvedValue(created);

      await expect(service.create(dto, ACTOR_ID)).resolves.toEqual(created);
      expect(databaseService.addon.create).toHaveBeenCalledWith({
        data: {
          ...dto,
          description: null,
          createdById: ACTOR_ID,
          updatedById: ACTOR_ID,
        },
      });
    });

    it("throws AddonCodeConflictException when the code is already taken", async () => {
      databaseService.addon.create.mockRejectedValue(uniqueConstraintError());

      await expect(
        service.create(
          {
            code: "WIFI_HOTSPOT",
            name: "Wi-Fi",
            bookingTypes: ["DAY"],
            pricingUnit: "PER_BOOKING",
            financialTreatment: "PLATFORM",
            isActive: true,
          },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(AddonCodeConflictException);
    });
  });

  describe("update", () => {
    it("throws AddonNotFoundException when the catalog row is missing", async () => {
      databaseService.addon.update.mockRejectedValue(recordNotFoundError());

      await expect(
        service.update("addon-missing", { isActive: false }, ACTOR_ID),
      ).rejects.toBeInstanceOf(AddonNotFoundException);
    });
  });

  describe("createPrice", () => {
    it("throws AddonNotFoundException when the add-on does not exist", async () => {
      databaseService.addon.findUnique.mockResolvedValue(null);

      await expect(
        service.createPrice(
          "addon-missing",
          { amount: 10000, effectiveSince: new Date("2026-01-01") },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(AddonNotFoundException);
    });

    it("throws AddonPriceOverlapException when the window overlaps an existing price", async () => {
      databaseService.addon.findUnique.mockResolvedValue({ id: "addon-1" });
      databaseService.addonPrice.findFirst.mockResolvedValue({ id: "price-existing" });

      await expect(
        service.createPrice(
          "addon-1",
          { amount: 12000, effectiveSince: new Date("2026-01-01") },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(AddonPriceOverlapException);
    });

    it("creates a price and returns a numeric amount", async () => {
      databaseService.addon.findUnique.mockResolvedValue({ id: "addon-1" });
      databaseService.addonPrice.findFirst.mockResolvedValue(null);
      databaseService.addonPrice.create.mockResolvedValue({
        id: "price-1",
        addonId: "addon-1",
        amount: new Decimal(12000),
        effectiveSince: new Date("2026-01-01"),
        effectiveUntil: null,
        createdById: ACTOR_ID,
        updatedById: ACTOR_ID,
      });

      const result = await service.createPrice(
        "addon-1",
        { amount: 12000, effectiveSince: new Date("2026-01-01") },
        ACTOR_ID,
      );

      expect(result.amount).toBe(12000);
      expect(databaseService.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
      });
    });
  });

  describe("endPrice", () => {
    it("throws when the price is missing or belongs to another add-on", async () => {
      databaseService.addonPrice.findUnique.mockResolvedValue(null);
      await expect(service.endPrice("addon-1", "price-1", ACTOR_ID)).rejects.toBeInstanceOf(
        AddonPriceNotFoundException,
      );

      databaseService.addonPrice.findUnique.mockResolvedValue({
        id: "price-1",
        addonId: "addon-other",
        effectiveSince: new Date("2020-01-01"),
        effectiveUntil: null,
      });
      await expect(service.endPrice("addon-1", "price-1", ACTOR_ID)).rejects.toBeInstanceOf(
        AddonPriceNotFoundException,
      );
    });

    it("rejects ending a price that already has an end date", async () => {
      databaseService.addonPrice.findUnique.mockResolvedValue({
        id: "price-1",
        addonId: "addon-1",
        effectiveSince: new Date("2020-01-01"),
        effectiveUntil: new Date("2026-01-01"),
      });

      await expect(service.endPrice("addon-1", "price-1", ACTOR_ID)).rejects.toBeInstanceOf(
        AddonPriceCannotEndException,
      );
    });

    it("rejects ending a future price", async () => {
      databaseService.addonPrice.findUnique.mockResolvedValue({
        id: "price-1",
        addonId: "addon-1",
        effectiveSince: new Date("2026-07-01"),
        effectiveUntil: null,
      });

      await expect(service.endPrice("addon-1", "price-1", ACTOR_ID)).rejects.toBeInstanceOf(
        AddonPriceCannotEndException,
      );
    });

    it("ends an open current price at now", async () => {
      databaseService.addonPrice.findUnique.mockResolvedValue({
        id: "price-1",
        addonId: "addon-1",
        effectiveSince: new Date("2020-01-01"),
        effectiveUntil: null,
      });
      databaseService.addonPrice.update.mockResolvedValue({
        id: "price-1",
        addonId: "addon-1",
        amount: new Decimal(10000),
        effectiveSince: new Date("2020-01-01"),
        effectiveUntil: NOW,
        updatedById: ACTOR_ID,
      });

      const result = await service.endPrice("addon-1", "price-1", ACTOR_ID);

      expect(databaseService.addonPrice.update).toHaveBeenCalledWith({
        where: { id: "price-1" },
        data: { effectiveUntil: NOW, updatedById: ACTOR_ID },
      });
      expect(result.amount).toBe(10000);
      expect(result.effectiveUntil).toEqual(NOW);
    });
  });

  describe("resolveBookingAddons", () => {
    it("returns an empty list without querying when no IDs are selected", async () => {
      await expect(service.resolveBookingAddons([], "DAY", 2)).resolves.toEqual([]);
      expect(databaseService.addon.findMany).not.toHaveBeenCalled();
    });

    it("rejects duplicate IDs", async () => {
      await expect(
        service.resolveBookingAddons(["addon-1", "addon-1"], "DAY", 1),
      ).rejects.toBeInstanceOf(InvalidBookingAddonsException);
      expect(databaseService.addon.findMany).not.toHaveBeenCalled();
    });

    it("rejects missing, inactive, inapplicable, or unpriced selections", async () => {
      databaseService.addon.findMany.mockResolvedValue([]);
      await expect(
        service.resolveBookingAddons(["addon-missing"], "DAY", 1),
      ).rejects.toBeInstanceOf(InvalidBookingAddonsException);

      databaseService.addon.findMany.mockResolvedValue([catalogAddon({ amount: null })]);
      await expect(service.resolveBookingAddons(["addon-1"], "DAY", 1)).rejects.toBeInstanceOf(
        InvalidBookingAddonsException,
      );
    });

    it("uses quantity 1 for PER_BOOKING and numberOfLegs for PER_LEG", async () => {
      databaseService.addon.findMany.mockResolvedValue([
        catalogAddon({
          id: "wifi",
          code: "WIFI_HOTSPOT",
          pricingUnit: "PER_BOOKING",
          amount: 10000,
        }),
      ]);
      const perBooking = await service.resolveBookingAddons(["addon-wifi"], "DAY", 3);
      expect(perBooking[0]).toMatchObject({
        quantity: 1,
        totalPrice: new Decimal(10000),
      });

      databaseService.addon.findMany.mockResolvedValue([
        catalogAddon({
          id: "security",
          code: "SECURITY_DETAIL",
          name: "Security Detail",
          pricingUnit: "PER_LEG",
          financialTreatment: "FLEET_OWNER",
          amount: 5000,
        }),
      ]);
      const perLeg = await service.resolveBookingAddons(["addon-security"], "DAY", 3);
      expect(perLeg[0]).toMatchObject({
        quantity: 3,
        unitPrice: new Decimal(5000),
        totalPrice: new Decimal(15000),
      });
    });

    it("returns add-ons sorted by code", async () => {
      databaseService.addon.findMany.mockResolvedValue([
        catalogAddon({ id: "z", code: "ZULU", name: "Zebra", amount: 1000 }),
        catalogAddon({ id: "a", code: "ALPHA", name: "Alpha", amount: 2000 }),
      ]);

      const result = await service.resolveBookingAddons(["addon-z", "addon-a"], "DAY", 1);

      expect(result.map((addon) => addon.code)).toEqual(["ALPHA", "ZULU"]);
    });

    it("reads from the transaction client when one is provided", async () => {
      const tx = {
        addon: {
          findMany: vi.fn().mockResolvedValue([catalogAddon({ id: "wifi", amount: 10000 })]),
        },
      };

      const result = await service.resolveBookingAddons(["wifi"], "DAY", 1, tx as never);

      expect(tx.addon.findMany).toHaveBeenCalledOnce();
      expect(databaseService.addon.findMany).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });
  });
});
