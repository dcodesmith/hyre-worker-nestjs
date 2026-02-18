import { z } from "zod";

const optionalIsoDateTime = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Invalid datetime format",
  })
  .optional();

export const flightAwareWebhookSchema = z.object({
  alert_id: z.string().trim().min(1, "alert_id is required"),
  event_type: z.string().trim().min(1, "event_type is required"),
  event_time: z
    .string()
    .trim()
    .min(1, "event_time is required")
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "event_time must be a valid ISO datetime",
    }),
  flight: z.object({
    ident: z.string().trim().min(1, "flight.ident is required"),
    fa_flight_id: z.string().trim().min(1, "flight.fa_flight_id is required"),
    registration: z.string().trim().optional(),
    aircraft_type: z.string().trim().optional(),
    origin: z.object({
      code: z.string().trim().min(1, "flight.origin.code is required"),
      code_iata: z.string().trim().optional(),
      name: z.string().trim().optional(),
      city: z.string().trim().optional(),
    }),
    destination: z.object({
      code: z.string().trim().min(1, "flight.destination.code is required"),
      code_iata: z.string().trim().optional(),
      name: z.string().trim().optional(),
      city: z.string().trim().optional(),
    }),
    scheduled_off: optionalIsoDateTime,
    scheduled_on: optionalIsoDateTime,
    scheduled_in: optionalIsoDateTime,
    estimated_off: optionalIsoDateTime,
    estimated_on: optionalIsoDateTime,
    estimated_in: optionalIsoDateTime,
    actual_off: optionalIsoDateTime,
    actual_on: optionalIsoDateTime,
    actual_in: optionalIsoDateTime,
    status: z.string().trim().optional(),
    delay_minutes: z.number().int().nonnegative().optional(),
    gate_origin: z.string().trim().optional(),
    gate_destination: z.string().trim().optional(),
  }),
});

export type FlightAwareWebhookDto = z.infer<typeof flightAwareWebhookSchema>;
