/**
 * IATA to ICAO airline code mapping for airlines flying to Nigeria
 * Used as fallback when FlightAware doesn't find the flight with IATA code
 */
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
