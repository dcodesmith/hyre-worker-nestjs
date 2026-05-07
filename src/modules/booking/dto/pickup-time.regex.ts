/**
 * Accepts pickup times like "9 AM", "9:00 AM", "11 PM", "2:30 PM".
 */
export const pickupTimeRegex = /^(1[0-2]|[1-9])(:[0-5]\d)?\s?(AM|PM)$/i;
