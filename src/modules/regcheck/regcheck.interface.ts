export type RegCheckErrorKind = "INVALID_RESPONSE" | "UNAVAILABLE";

export type RegCheckPlateResult = {
  plateNumber: string;
  vehicleName: string;
  color: string | null;
};
