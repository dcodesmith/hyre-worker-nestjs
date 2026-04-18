/**
 * The business operates in Lagos, Nigeria, which uses West Africa Time (UTC+01:00)
 * year-round with no DST observance. All user-facing calendar dates (start/end of
 * promotions, day bookings, etc.) are interpreted relative to this timezone before
 * being persisted as UTC instants.
 */
export const LAGOS_TIMEZONE = "Africa/Lagos";
