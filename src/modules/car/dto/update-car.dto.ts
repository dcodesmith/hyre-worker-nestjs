import { Status } from "@prisma/client";
import { z } from "zod";
import { createCarBodySchema } from "./create-car.dto";

export const carIdParamSchema = z.cuid();

export const updateCarBodySchema = createCarBodySchema
  .partial()
  .extend({
    status: z.enum([Status.AVAILABLE, Status.HOLD, Status.IN_SERVICE]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one update field is required",
    path: ["make"],
  })
  .superRefine((data, ctx) => {
    if (
      data.pricingIncludesFuel === false &&
      (data.fuelUpgradeRate === null || data.fuelUpgradeRate === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Fuel upgrade rate is required when pricing does not include fuel",
        path: ["fuelUpgradeRate"],
      });
    }
  });

export type UpdateCarBodyDto = z.infer<typeof updateCarBodySchema>;
