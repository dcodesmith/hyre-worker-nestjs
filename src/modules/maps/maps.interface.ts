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

export type GoogleRoutesOrigin =
  | { address: string }
  | { location: { latLng: { latitude: number; longitude: number } } };
