export interface GoogleRoutesResponse {
  routes: Array<{
    duration: string; // e.g., "3600s"
    distanceMeters: number;
    polyline?: {
      encodedPolyline: string;
    };
  }>;
}

export interface DriveTimeResult {
  durationMinutes: number;
  distanceMeters: number;
  isEstimate: boolean;
}

export interface PlaceSuggestion {
  placeId: string;
  description: string;
  types?: string[];
}

export interface AddressLookupResult {
  isValid: boolean;
  normalizedAddress?: string;
  placeId?: string;
  suggestions: PlaceSuggestion[];
  failureReason?: "AREA_ONLY" | "NO_MATCH" | "AMBIGUOUS";
}

export type GoogleRoutesOrigin = {
  location: { latLng: { latitude: number; longitude: number } };
};

export type PlacesAutocompleteNewResponse = {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      types?: string[];
      text?: {
        text?: string;
      };
    };
  }>;
};

export interface PlaceDetailsResponse {
  id?: string;
  types?: string[];
  formattedAddress?: string;
  displayName?: {
    text?: string;
    languageCode?: string;
  };
  addressComponents?: Array<{
    longText?: string;
    shortText?: string;
    types?: string[];
    languageCode?: string;
  }>;
}
