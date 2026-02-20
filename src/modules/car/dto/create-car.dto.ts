import { ServiceTier, Status, VehicleType } from "@prisma/client";
import { z } from "zod";

const registrationNumberSchema = z
  .string()
  .trim()
  .min(1, "Registration number is required")
  .transform((value) => value.toUpperCase())
  .pipe(
    z.string().refine(
      (value) => {
        const plate = value.replaceAll(/\s+/g, "");
        const stateFormat = /^[A-Z]{3}-?\d{3}[A-Z]{2}$/;
        const federalFormat = /^[A-Z]{2}\d{3}[A-Z]{2}$/;
        return stateFormat.test(plate) || federalFormat.test(plate);
      },
      {
        message:
          "Invalid Nigerian number plate format. Use formats like 'ABC-123XX', 'ABC123XX', or 'XX123XX'",
      },
    ),
  );

const carBaseSchema = z
  .object({
    make: z.string().trim().min(1),
    model: z.string().trim().min(1),
    year: z
      .number()
      .int()
      .min(2015)
      .max(new Date().getFullYear() + 1),
    color: z.string().trim().default(""),
    registrationNumber: registrationNumberSchema,
    status: z.enum([Status.AVAILABLE, Status.HOLD, Status.IN_SERVICE]).optional(),
    dayRate: z.number().int().positive(),
    hourlyRate: z.number().int().positive(),
    nightRate: z.number().int().positive(),
    fullDayRate: z.number().int().positive(),
    airportPickupRate: z.number().int().positive(),
    fuelUpgradeRate: z.number().int().positive().nullable().optional(),
    pricingIncludesFuel: z.boolean(),
    vehicleType: z.enum(VehicleType),
    serviceTier: z.enum(ServiceTier),
    passengerCapacity: z.number().int().min(1).max(15),
  })
  .superRefine((data, ctx) => {
    if (
      !data.pricingIncludesFuel &&
      (data.fuelUpgradeRate === null || data.fuelUpgradeRate === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Fuel upgrade rate is required when pricing does not include fuel",
        path: ["fuelUpgradeRate"],
      });
    }
  });

const parseBoolean = (value: unknown): unknown => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "on") return true;
    if (normalized === "false" || normalized === "off" || normalized === "") return false;
  }
  return value;
};

const parseNullableInt = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
};

export const createCarBodySchema = carBaseSchema;

export const createCarMultipartBodySchema = z
  .object({
    make: z.string().trim().min(1),
    model: z.string().trim().min(1),
    year: z.coerce
      .number()
      .int()
      .min(2015)
      .max(new Date().getFullYear() + 1),
    color: z.string().trim().default(""),
    registrationNumber: registrationNumberSchema,
    status: z
      .string()
      .optional()
      .transform((value) => value ?? undefined)
      .pipe(z.enum([Status.AVAILABLE, Status.HOLD, Status.IN_SERVICE]).optional()),
    dayRate: z.coerce.number().int().positive(),
    hourlyRate: z.coerce.number().int().positive(),
    nightRate: z.coerce.number().int().positive(),
    fullDayRate: z.coerce.number().int().positive(),
    airportPickupRate: z.coerce.number().int().positive(),
    fuelUpgradeRate: z.preprocess(
      parseNullableInt,
      z.coerce.number().int().positive().nullable().optional(),
    ),
    pricingIncludesFuel: z.preprocess(parseBoolean, z.boolean()),
    vehicleType: z.enum(VehicleType),
    serviceTier: z.enum(ServiceTier),
    passengerCapacity: z.coerce.number().int().min(1).max(15),
  })
  .superRefine((data, ctx) => {
    if (
      !data.pricingIncludesFuel &&
      (data.fuelUpgradeRate === null || data.fuelUpgradeRate === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Fuel upgrade rate is required when pricing does not include fuel",
        path: ["fuelUpgradeRate"],
      });
    }
  });

export type CreateCarBodyDto = z.infer<typeof createCarBodySchema>;
export type CreateCarMultipartBodyDto = z.infer<typeof createCarMultipartBodySchema>;
