import type { ServiceTier, VehicleType } from "@prisma/client";
import type {
  AvailabilitySearchFilters,
  SearchAnalyticsContext,
} from "../analytics/analytics.interface";
import type { CarSearchQueryDto } from "./dto/car-search.dto";

export interface AvailabilityInterval {
  startDate: Date;
  endDate: Date;
}

export type CarRateField = "dayRate" | "nightRate" | "fullDayRate" | "airportPickupRate";

export interface PrepareSearchAnalyticsParams {
  query: CarSearchQueryDto;
  context: SearchAnalyticsContext | undefined;
  interval: AvailabilityInterval | null;
  vehicleTypes: VehicleType[];
  serviceTiers: ServiceTier[];
  occurredAt: Date;
}

export interface PreparedSearchAnalytics {
  context: SearchAnalyticsContext & { searchId: string };
  occurredAt: Date;
  filters: AvailabilitySearchFilters;
  filterFingerprint: string;
}

export interface UploadedCarFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface CarUploadFields {
  images?: UploadedCarFile[];
  vehicleRegistration?: UploadedCarFile[];
  motCertificate?: UploadedCarFile[];
  insuranceCertificate?: UploadedCarFile[];
}

export interface CarDocumentFiles {
  vehicleRegistration: UploadedCarFile;
  motCertificate: UploadedCarFile;
  insuranceCertificate: UploadedCarFile;
}
