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

export interface PlacesAutocompleteResponse {
  suggestions: PlaceSuggestion[];
  meta?: {
    degraded: boolean;
  };
}

export interface ResolvePlaceResponse {
  placeId: string;
  address: string | null;
  types: string[];
  meta?: {
    degraded: boolean;
  };
}

export interface AddressLookupResult {
  isValid: boolean;
  normalizedAddress: string | null;
  placeId: string | null;
  failureReason: "AREA_ONLY" | "NO_MATCH" | "AMBIGUOUS" | null;
}

export type ValidatePlaceResponse = AddressLookupResult;

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
  businessStatus?: string;
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
