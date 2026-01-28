import { z } from "zod";

/**
 * Booking type enum values matching Prisma schema
 */
export const BOOKING_TYPES = ["DAY", "NIGHT", "FULL_DAY", "AIRPORT_PICKUP"] as const;
export type BookingType = (typeof BOOKING_TYPES)[number];

/**
 * Pickup time format validation
 * Accepts: "9 AM", "9:00 AM", "11 PM", "2:30 PM"
 */
const pickupTimeRegex = /^(1[0-2]|[1-9])(:[0-5]\d)?\s?(AM|PM)$/i;

/**
 * Core booking fields shared between logged-in and guest bookings
 */
const coreBookingFields = z.object({
  carId: z.string().min(1, "Car ID is required"),
  startDate: z.coerce.date("Invalid start date format"),
  endDate: z.coerce.date("Invalid end date format"),
  pickupAddress: z.string().min(1, "Pickup address is required"),
  bookingType: z.enum(BOOKING_TYPES, {
    message: "Booking type must be DAY, NIGHT, FULL_DAY, or AIRPORT_PICKUP",
  }),
  pickupTime: z.string().optional(),
  flightNumber: z.string().optional(),
  includeSecurityDetail: z.boolean().default(false),
  requiresFullTank: z.boolean().default(false),
  specialRequests: z.string().optional(),
  useCredits: z.number().min(0).default(0),
  clientTotalAmount: z.string().optional(), // Decimal string for price validation
});

/**
 * Drop-off address schema (required when sameLocation is false)
 */
const dropOffSchema = z.object({
  dropOffAddress: z.string().min(1, "Drop-off address is required"),
});

/**
 * Guest booking fields (when user is not authenticated)
 */
const guestInfoSchema = z.object({
  guestEmail: z.email("Invalid email address"),
  guestName: z.string().min(2, "Name must be at least 2 characters"),
  guestPhone: z.string().min(10, "Phone number must be at least 10 digits"),
});

/**
 * Logged-in user booking schema with same location
 */
const bookingSchemaSameLocation = coreBookingFields.extend({
  sameLocation: z.literal(true),
});

/**
 * Logged-in user booking schema with different location
 */
const bookingSchemaDifferentLocation = coreBookingFields
  .extend({
    sameLocation: z.literal(false),
  })
  .extend(dropOffSchema.shape);

/**
 * Guest booking schema with same location
 */
const guestSchemaSameLocation = bookingSchemaSameLocation.extend(guestInfoSchema.shape);

/**
 * Guest booking schema with different location
 */
const guestSchemaDifferentLocation = bookingSchemaDifferentLocation.extend(guestInfoSchema.shape);

/**
 * Discriminated union for logged-in user bookings
 */
const loggedInUserBookingSchema = z.discriminatedUnion("sameLocation", [
  bookingSchemaSameLocation,
  bookingSchemaDifferentLocation,
]);

/**
 * Discriminated union for guest bookings
 */
const guestUserBookingSchema = z.discriminatedUnion("sameLocation", [
  guestSchemaSameLocation,
  guestSchemaDifferentLocation,
]);

/**
 * Pickup time validation refinement
 */
function validatePickupTime(data: { bookingType: BookingType; pickupTime?: string }): boolean {
  if (data.bookingType === "DAY" || data.bookingType === "FULL_DAY") {
    return (
      typeof data.pickupTime === "string" &&
      data.pickupTime.trim() !== "" &&
      pickupTimeRegex.test(data.pickupTime.trim())
    );
  }
  return true;
}

/**
 * Flight number validation refinement
 */
function validateFlightNumber(data: { bookingType: BookingType; flightNumber?: string }): boolean {
  if (data.bookingType === "AIRPORT_PICKUP") {
    return typeof data.flightNumber === "string" && data.flightNumber.trim() !== "";
  }
  return true;
}

/**
 * Apply common booking refinements to a schema
 */
function withBookingRefinements<
  T extends z.ZodType<{
    bookingType: BookingType;
    pickupTime?: string;
    flightNumber?: string;
    startDate: Date;
    endDate: Date;
  }>,
>(schema: T) {
  return schema
    .refine(validatePickupTime, {
      message: "Pickup time is required for DAY and FULL_DAY bookings (format: H:MM AM/PM)",
      path: ["pickupTime"],
    })
    .refine(validateFlightNumber, {
      message: "Flight number is required for AIRPORT_PICKUP bookings",
      path: ["flightNumber"],
    })
    .refine((data) => data.endDate > data.startDate, {
      message: "End date must be after start date",
      path: ["endDate"],
    });
}

/**
 * Full booking schema for logged-in users (with refinements)
 */
export const createBookingSchema = withBookingRefinements(loggedInUserBookingSchema);

/**
 * Full booking schema for guest users (with refinements)
 */
export const createGuestBookingSchema = withBookingRefinements(guestUserBookingSchema);

/**
 * Type inference for logged-in user booking DTO
 */
export type CreateBookingDto = z.infer<typeof loggedInUserBookingSchema>;

/**
 * Type inference for guest booking DTO
 */
export type CreateGuestBookingDto = z.infer<typeof guestUserBookingSchema>;

/**
 * Union type for both booking types
 */
export type CreateBookingInput = CreateBookingDto | CreateGuestBookingDto;

/**
 * Type guard to check if booking input is a guest booking
 */
export function isGuestBooking(input: CreateBookingInput): input is CreateGuestBookingDto {
  return "guestEmail" in input && "guestName" in input && "guestPhone" in input;
}
