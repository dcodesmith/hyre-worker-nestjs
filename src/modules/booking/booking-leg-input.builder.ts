import { BookingType } from "@prisma/client";
import type { LegGenerationInput } from "./booking.interface";

type BuildLegGenerationInputParams = {
  bookingType: BookingType;
  startDate: Date;
  endDate: Date;
  pickupTime: string;
  flightArrivalTime?: Date;
  driveTimeMinutes?: number;
};

export function buildLegGenerationInput(params: BuildLegGenerationInputParams): LegGenerationInput {
  const { bookingType, startDate, endDate, pickupTime, flightArrivalTime, driveTimeMinutes } =
    params;

  switch (bookingType) {
    case BookingType.DAY:
      return {
        bookingType: BookingType.DAY,
        startDate,
        endDate,
        pickupTime,
      };
    case BookingType.NIGHT:
      return {
        bookingType: BookingType.NIGHT,
        startDate,
        endDate,
      };
    case BookingType.FULL_DAY:
      return {
        bookingType: BookingType.FULL_DAY,
        startDate,
        endDate,
        pickupTime,
      };
    case BookingType.AIRPORT_PICKUP:
      return {
        bookingType: BookingType.AIRPORT_PICKUP,
        startDate,
        endDate,
        flightArrivalTime,
        driveTimeMinutes,
      };
    default: {
      const exhaustiveCheck: never = bookingType;
      throw new Error(`Unknown booking type: ${exhaustiveCheck}`);
    }
  }
}
