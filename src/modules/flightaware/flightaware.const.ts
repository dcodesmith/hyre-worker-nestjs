/**
 * IATA to ICAO airline code mapping for airlines flying to Nigeria
 * Used as fallback when FlightAware doesn't find the flight with IATA code
 */
export const FLIGHT_NUMBER_REGEX = /^[A-Z0-9]{2,3}\d{1,5}$/i;
export const ISO_DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

export const parseIsoDateOnlyToUtc = (value: string): Date | null => {
  const dateOnlyMatch = ISO_DATE_ONLY_REGEX.exec(value);
  if (!dateOnlyMatch) {
    return null;
  }

  const year = Number.parseInt(dateOnlyMatch[1], 10);
  const month = Number.parseInt(dateOnlyMatch[2], 10);
  const day = Number.parseInt(dateOnlyMatch[3], 10);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
};

export const IATA_TO_ICAO_MAP: Record<string, string> = {
  // International carriers
  AF: "AFR", // Air France
  AT: "RAM", // Royal Air Maroc
  BA: "BAW", // British Airways
  DL: "DAL", // Delta Air Lines
  DT: "DTA", // TAAG Angola Airlines
  EK: "UAE", // Emirates
  ET: "ETH", // Ethiopian Airlines
  EY: "ETD", // Etihad Airways
  KL: "KLM", // KLM Royal Dutch Airlines
  KQ: "KQA", // Kenya Airways
  LH: "DLH", // Lufthansa
  ME: "MEA", // Middle East Airlines
  MS: "MSR", // EgyptAir
  QR: "QTR", // Qatar Airways
  RJ: "RJA", // Royal Jordanian
  SA: "SAA", // South African Airways
  SV: "SVA", // Saudi Arabian Airlines
  TK: "THY", // Turkish Airlines
  UA: "UAL", // United Airlines
  VS: "VIR", // Virgin Atlantic
  WB: "RWD", // RwandAir Express
  // African regional carriers
  AW: "AFW", // Africa World Airlines
  HF: "VRE", // Air Cote d'Ivoire
  KP: "SKK", // ASKY Airlines
  OJ: "OLA", // Overland Airways (Nigeria)
  // Nigerian carriers
  P4: "APK", // Air Peace
  VK: "VGN", // Virgin Nigeria Airways
  W3: "ARA", // Arik Air
};
