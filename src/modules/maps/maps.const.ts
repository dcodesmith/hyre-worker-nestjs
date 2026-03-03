/**
 * Lagos airport coordinates (Murtala Muhammed International Airport)
 */
export const LAGOS_AIRPORT_COORDS = {
  latitude: 6.5774,
  longitude: 3.3212,
};

/**
 * Lagos service bounds used to restrict Places suggestions to Lagos only.
 * Viewport corners follow Google Places rectangle format.
 */
export const LAGOS_VIEWPORT_BOUNDS = {
  low: {
    latitude: 6.23,
    longitude: 3,
  },
  high: {
    latitude: 6.7,
    longitude: 3.7,
  },
};

/**
 * Default fallback duration when API fails (3 hours)
 */
export const FALLBACK_DURATION_MINUTES = 180;
