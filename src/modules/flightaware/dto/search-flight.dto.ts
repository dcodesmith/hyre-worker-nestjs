import { z } from "zod";
import { FLIGHT_NUMBER_REGEX, parseIsoDateOnlyToUtc } from "../flightaware.const";

const ISO_DATETIME_WITH_TIMEZONE_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const parseIsoDateToUtc = (value: string): Date | null => {
  const dateOnlyUtc = parseIsoDateOnlyToUtc(value);
  if (dateOnlyUtc) {
    return dateOnlyUtc;
  }

  if (!ISO_DATETIME_WITH_TIMEZONE_REGEX.test(value)) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const isValidIsoDate = (value: string): boolean => parseIsoDateToUtc(value) !== null;

const isPastDate = (value: string): boolean => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const date = parseIsoDateToUtc(value);
  if (!date) {
    return false;
  }
  date.setUTCHours(0, 0, 0, 0);

  return date < today;
};

const isMoreThanOneYearAhead = (value: string): boolean => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const oneYearFromNow = new Date(today);
  oneYearFromNow.setUTCFullYear(today.getUTCFullYear() + 1);

  const date = parseIsoDateToUtc(value);
  if (!date) {
    return false;
  }
  date.setUTCHours(0, 0, 0, 0);

  return date > oneYearFromNow;
};

export const searchFlightQuerySchema = z.object({
  flightNumber: z
    .string()
    .trim()
    .min(1, "Missing required parameter: flightNumber")
    .regex(
      FLIGHT_NUMBER_REGEX,
      "Invalid flight number format. Expected format: 2-3 alphanumeric airline code + 1-5 digits (e.g., BA74, AA123, P47579)",
    )
    .transform((value) => value.toUpperCase()),
  date: z
    .string()
    .trim()
    .min(1, "Missing required parameter: date")
    .refine(isValidIsoDate, {
      message: "Invalid date format. Expected ISO date string (e.g., 2025-12-25)",
    })
    .refine((value) => !isPastDate(value), {
      message: "Cannot search for flights in the past. Please select a future date.",
    })
    .refine((value) => !isMoreThanOneYearAhead(value), {
      message: "Cannot search for flights more than 1 year in the future",
    }),
});

export type SearchFlightQueryDto = z.infer<typeof searchFlightQuerySchema>;
