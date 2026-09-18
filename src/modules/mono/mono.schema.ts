import { z } from "zod";

const optionalText = z
  .string()
  .nullish()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  });

export const monoEnvelopeSchema = z.looseObject({
  status: z.string(),
  message: z.string().optional(),
  timestamp: z.string().optional(),
});

export const monoNinResponseSchema = z.looseObject({
  status: z.literal("successful"),
  timestamp: z.string().optional(),
  data: z.looseObject({
    nin: z.string().regex(/^\d{11}$/),
    firstname: z.string().trim().min(1),
    middlename: optionalText,
    surname: z.string().trim().min(1),
    birthdate: z.string().min(1),
    photo: optionalText,
  }),
});

export const monoDriversLicenseResponseSchema = z.looseObject({
  status: z.literal("successful"),
  timestamp: z.string().optional(),
  data: z.looseObject({
    license_no: z.string().min(1),
    first_name: z.string().trim().min(1),
    last_name: z.string().trim().min(1),
    middle_name: optionalText,
    birth_date: z.string().min(1),
    expiry_date: z.string().min(1),
    photo: optionalText,
  }),
});
