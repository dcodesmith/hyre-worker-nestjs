import { z } from "zod";

export const FRSC_DRIVERS_LICENSE_NUMBER = /^[A-Z]{2,3}\d{5}[A-Z]{2}\d{2}$/;
export const DRIVERS_LICENSE_NUMBER_INVALID = "Enter a valid driver's licence number";

export function normalizeDriversLicenseNumber(value: string): string {
  return value.toUpperCase().replace(/[\s-]+/g, "");
}

export const driversLicenseNumberSchema = z
  .string()
  .trim()
  .transform(normalizeDriversLicenseNumber)
  .refine((value) => FRSC_DRIVERS_LICENSE_NUMBER.test(value), {
    message: DRIVERS_LICENSE_NUMBER_INVALID,
  });

export const optionalDriversLicenseNumberSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return normalizeDriversLicenseNumber(value.trim()) === "" ? undefined : value;
}, driversLicenseNumberSchema.optional());
