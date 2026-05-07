import { z } from "zod";
import { pickupTimeRegex } from "./pickup-time.regex";

export const updateBookingBodySchema = z
  .object({
    pickupTime: z.string().trim().regex(pickupTimeRegex).optional(),
    pickupAddress: z.string().trim().min(1).optional(),
    sameLocation: z.boolean().optional(),
    dropOffAddress: z.string().trim().min(1).optional(),
  })
  .refine(
    (data) =>
      data.pickupTime !== undefined ||
      data.pickupAddress !== undefined ||
      data.sameLocation !== undefined ||
      data.dropOffAddress !== undefined,
    {
      message: "At least one update field is required",
      path: ["pickupAddress"],
    },
  )
  .refine((data) => !(data.sameLocation === false && !data.dropOffAddress), {
    message: "Drop-off address is required when sameLocation is false",
    path: ["dropOffAddress"],
  });

export type UpdateBookingBodyDto = z.infer<typeof updateBookingBodySchema>;
