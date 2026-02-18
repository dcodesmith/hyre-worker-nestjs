import { z } from "zod";

const FLIGHT_NUMBER_REGEX = /^[A-Z0-9]{2,3}\d{1,5}$/i;

const isValidIsoDate = (value: string): boolean => !Number.isNaN(Date.parse(value));

const isPastDate = (value: string): boolean => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const date = new Date(value);
  date.setHours(0, 0, 0, 0);

  return date < today;
};

const isMoreThanOneYearAhead = (value: string): boolean => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const oneYearFromNow = new Date(today);
  oneYearFromNow.setFullYear(today.getFullYear() + 1);

  return new Date(value) > oneYearFromNow;
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
