import { z } from "zod";
import { carBaseBodySchema, validateFuelUpgradeRate } from "./create-car.dto";

export const updateCarPricingSchema = carBaseBodySchema
  .pick({
    dayRate: true,
    hourlyRate: true,
    nightRate: true,
    fullDayRate: true,
    airportPickupRate: true,
    fuelUpgradeRate: true,
    pricingIncludesFuel: true,
    vehicleType: true,
    serviceTier: true,
    passengerCapacity: true,
  })
  .partial({ passengerCapacity: true })
  .superRefine(validateFuelUpgradeRate);

export type UpdateCarPricingDto = z.infer<typeof updateCarPricingSchema>;
