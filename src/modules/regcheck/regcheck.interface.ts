export type RegCheckErrorKind = "INVALID_RESPONSE" | "UNAVAILABLE";

export type RegCheckPlateResult = {
  plateNumber: string;
  vehicleName: string;
  make: string;
  model: string;
  color: string | null;
};
