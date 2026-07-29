import { z } from "zod";

const optionalIsoDateTime = z
  .string()
  .trim()
  .nullish()
  .refine((value) => !value || !Number.isNaN(Date.parse(value)), {
    message: "Invalid datetime format",
  })
  .transform((value) => value || undefined);

const optionalString = z
  .string()
  .trim()
  .nullish()
  .transform((value) => value || undefined);

const nullableOptionalString = z
  .string()
  .trim()
  .nullable()
  .optional()
  .transform((value) => (value === "" ? null : value));

export const flightAwareEventCodeSchema = z.enum([
  "filed",
  "departure",
  "arrival",
  "out",
  "off",
  "on",
  "in",
  "diverted",
  "cancelled",
  "position_only_arrival",
  "position_only_departure",
  "fru_arrival",
  "nonairport_arrival",
  "nonairport_departure",
  "nonairport_filed",
  "minutes_out",
  "power_on",
  "change",
]);

export const flightAwareWebhookSchema = z.object({
  alert_id: z.number().int().nonnegative(),
  event_code: flightAwareEventCodeSchema,
  long_description: z.string(),
  short_description: z.string(),
  summary: z.string(),
  flight: z.object({
    fa_flight_id: z.string().trim().min(1, "flight.fa_flight_id is required"),
    ident: optionalString,
    registration: optionalString,
    aircraft_type: optionalString,
    origin: optionalString,
    origin_icao: optionalString,
    origin_iata: optionalString,
    destination: optionalString,
    destination_icao: optionalString,
    destination_iata: optionalString,
    cancelled: z.boolean().optional(),
    diverted: z.boolean().optional(),
    scheduled_out: optionalIsoDateTime,
    scheduled_off: optionalIsoDateTime,
    scheduled_on: optionalIsoDateTime,
    scheduled_in: optionalIsoDateTime,
    estimated_out: optionalIsoDateTime,
    estimated_off: optionalIsoDateTime,
    estimated_on: optionalIsoDateTime,
    estimated_in: optionalIsoDateTime,
    actual_out: optionalIsoDateTime,
    actual_off: optionalIsoDateTime,
    actual_on: optionalIsoDateTime,
    actual_in: optionalIsoDateTime,
    gate_origin: nullableOptionalString,
    gate_destination: nullableOptionalString,
    terminal_origin: nullableOptionalString,
    terminal_destination: nullableOptionalString,
  }),
});

export type FlightAwareWebhookDto = z.infer<typeof flightAwareWebhookSchema>;
export type FlightAwareEventCode = z.infer<typeof flightAwareEventCodeSchema>;
