export const BOOKING_BUFFER_HOURS = 2;

export interface BookingInterval {
  startDate: Date;
  endDate: Date;
}

export interface BufferedBookingInterval {
  bufferedStart: Date;
  bufferedEnd: Date;
}

/**
 * Applies booking prep buffer to both sides of a requested interval.
 * Shared by search-time filtering and final booking validation to keep
 * overlap semantics aligned.
 */
export function buildBufferedBookingInterval(
  interval: BookingInterval,
  bufferHours: number = BOOKING_BUFFER_HOURS,
): BufferedBookingInterval {
  const bufferMs = bufferHours * 60 * 60 * 1000;
  return {
    bufferedStart: new Date(interval.startDate.getTime() - bufferMs),
    bufferedEnd: new Date(interval.endDate.getTime() + bufferMs),
  };
}

/**
 * Builds the query interval used to compare an unbuffered stored booking with
 * the exclusion constraint. The database extends each booking's end by two
 * hours, so querying raw start/end columns requires extending both sides of
 * the candidate interval by the same two-hour turnaround gap.
 */
export function buildBookingConflictQueryInterval(
  interval: BookingInterval,
): BufferedBookingInterval {
  return buildBufferedBookingInterval(interval);
}
