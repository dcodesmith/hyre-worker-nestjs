import { z } from "zod";

const verificationSchema = z.looseObject({
  status: z.literal("VERIFIED"),
  reference: z.string().min(1),
});

export const premblyEnvelopeSchema = z.looseObject({
  status: z.boolean(),
  detail: z.string().optional(),
  response_code: z.string().optional(),
});

const plateVehicleSchema = z.looseObject({
  ChassisNo: z.string().optional(),
  bodyColor: z.string().optional(),
  carMake: z.string().optional(),
  carModel: z.string().optional(),
});

export const premblyPlateResponseSchema = z.looseObject({
  status: z.literal(true),
  response_code: z.literal("00"),
  data: z.looseObject({
    vehicle_number: z.string().optional(),
    vehicle_name: z.string().optional(),
    vehicle_color: z.string().optional(),
    ChassisNo: z.string().optional(),
    chassis_number: z.string().optional(),
    vehicle: plateVehicleSchema.optional(),
  }),
  verification: verificationSchema,
});

export const premblyVinResponseSchema = z.looseObject({
  status: z.literal(true),
  response_code: z.literal("00"),
  data: z.looseObject({
    vehicle_name: z.string().optional(),
    vehicle_specification: z.array(z.record(z.string(), z.string())),
  }),
  verification: verificationSchema,
});

export const premblyInsuranceResponseSchema = z.looseObject({
  status: z.literal(true),
  response_code: z.literal("00"),
  data: z.looseObject({
    policy_number: z.string().min(1),
    new_reg_number: z.string().optional(),
    reg_number: z.string().optional(),
    vehicle_color: z.string().trim().min(1),
    vehicle_chasis: z.string().optional(),
    policy_status: z.string().min(1),
    expiry_date: z.coerce.date(),
  }),
  verification: verificationSchema,
});

export const premblyNinResponseSchema = z.looseObject({
  status: z.literal(true),
  response_code: z.literal("00"),
  data: z.looseObject({
    firstname: z.string().min(1),
    middlename: z.string().nullish(),
    surname: z.string().min(1),
    nin: z.string().regex(/^\d{11}$/),
    nin_suspension_status: z.boolean(),
  }),
  verification: verificationSchema,
});

const cacDirectorSchema = z.looseObject({
  firstname: z.string().default(""),
  surname: z.string().default(""),
  otherName: z.string().nullish(),
});

export const premblyCacResponseSchema = z.looseObject({
  status: z.literal(true),
  response_code: z.literal("00"),
  data: z.array(
    z.looseObject({
      rc_number: z.string().min(1),
      company_name: z.string().min(1),
      company_status: z.string().nullish(),
      entity_type: z.string().min(1),
      directors: z.array(cacDirectorSchema).optional().default([]),
    }),
  ),
  verification: verificationSchema,
});
