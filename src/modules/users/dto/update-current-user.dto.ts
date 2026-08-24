import { z } from "zod";

const optionalNullableTrimmedString = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

export const updateCurrentUserBodySchema = z
  .object({
    name: optionalNullableTrimmedString(200),
    phoneNumber: optionalNullableTrimmedString(32),
    city: optionalNullableTrimmedString(120),
    address: optionalNullableTrimmedString(500),
    marketingConsent: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.phoneNumber !== undefined ||
      value.city !== undefined ||
      value.address !== undefined ||
      value.marketingConsent !== undefined,
    {
      message: "At least one field must be provided",
    },
  );

export type UpdateCurrentUserBodyDto = z.infer<typeof updateCurrentUserBodySchema>;
