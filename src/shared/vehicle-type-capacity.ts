export const VEHICLE_TYPES = ["SEDAN", "SUV", "CROSSOVER", "VAN"] as const;

export type InferredVehicleType = (typeof VEHICLE_TYPES)[number];

export const DEFAULT_SEATS_BY_VEHICLE_TYPE: Record<InferredVehicleType, number> = {
  SEDAN: 5,
  SUV: 5,
  CROSSOVER: 5,
  VAN: 7,
};

export function inferVehicleTypeFromClassifiers(
  ...classifiers: Array<string | null | undefined>
): InferredVehicleType | null {
  const normalized = classifiers
    .map((value) => normalizeClassifier(value))
    .filter((value): value is string => Boolean(value));

  for (const value of normalized) {
    const inferred = classifyNormalized(value);
    if (inferred) return inferred;
  }

  return null;
}

export function inferPassengerCapacityFromVehicleClass(
  ...classifiers: Array<string | null | undefined>
): number | null {
  const vehicleType = inferVehicleTypeFromClassifiers(...classifiers);
  return vehicleType ? DEFAULT_SEATS_BY_VEHICLE_TYPE[vehicleType] : null;
}

export function resolvePassengerCapacity(
  decodedSeats: number | null | undefined,
  ...classifiers: Array<string | null | undefined>
): number | null {
  if (Number.isInteger(decodedSeats) && decodedSeats && decodedSeats >= 1 && decodedSeats <= 15) {
    return decodedSeats;
  }
  return inferPassengerCapacityFromVehicleClass(...classifiers);
}

function normalizeClassifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, " ")
    .trim();
  return normalized || null;
}

function classifyNormalized(value: string): InferredVehicleType | null {
  const tokens = ` ${value} `;

  if (hasToken(tokens, "CARGO") && hasToken(tokens, "VAN")) return null;
  if (hasToken(tokens, "CROSSOVER") || hasToken(tokens, "CUV")) return "CROSSOVER";
  if (hasToken(tokens, "MINIVAN")) return "VAN";
  if (hasToken(tokens, "SUV") || tokens.includes(" SPORT UTILITY ")) return "SUV";
  if (tokens.includes(" MULTIPURPOSE ") || hasToken(tokens, "MPV")) return "SUV";
  if (hasToken(tokens, "VAN")) return "VAN";
  if (
    hasToken(tokens, "SEDAN") ||
    hasToken(tokens, "SALOON") ||
    hasToken(tokens, "HATCHBACK") ||
    hasToken(tokens, "LIFTBACK") ||
    hasToken(tokens, "NOTCHBACK") ||
    hasToken(tokens, "WAGON") ||
    hasToken(tokens, "COUPE") ||
    hasToken(tokens, "CONVERTIBLE") ||
    hasToken(tokens, "CABRIOLET") ||
    tokens.includes(" PASSENGER CAR ")
  ) {
    return "SEDAN";
  }

  return null;
}

function hasToken(tokens: string, token: string): boolean {
  return tokens.includes(` ${token} `);
}
