import { Status } from "@prisma/client";
import { z } from "zod";
import { carBaseBodySchema, validateFuelUpgradeRate } from "./create-car.dto";

export const carIdParamSchema = z.cuid();

export const updateCarBodySchema = carBaseBodySchema
  .partial()
  .extend({
    status: z.enum([Status.AVAILABLE, Status.HOLD, Status.IN_SERVICE]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one update field is required",
    path: ["make"],
  })
  .superRefine(validateFuelUpgradeRate);

export type UpdateCarBodyDto = z.infer<typeof updateCarBodySchema>;
