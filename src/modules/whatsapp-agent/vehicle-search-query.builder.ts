import type { VehicleType } from "@prisma/client";
import type { ExtractedAiSearchParams } from "../ai-search/ai-search.interface";
import type { CarSearchQueryDto } from "../car/dto/car-search.dto";
import { normalizeBookingType, parseSearchDate } from "./vehicle-search-precondition.policy";

export class VehicleSearchQueryBuilder {
  private readonly knownMultiWordMakes = new Set<string>(["land rover", "mercedes benz", "mini"]);
  constructor(private readonly maxSearchCandidates: number) {}

  parseVehicleModel(value: string | undefined): { make?: string; model?: string } {
    if (!value) {
      return {};
    }
    const normalized = value.trim().replaceAll(/\s+/g, " ");
    if (!normalized) {
      return {};
    }

    const parts = normalized.split(" ");
    if (parts.length === 1) {
      const canonicalFullInput = this.canonicalizeMake(normalized);
      if (this.knownMultiWordMakes.has(canonicalFullInput)) {
        return { make: normalized };
      }
      return { model: normalized };
    }

    const canonicalFullInput = this.canonicalizeMake(normalized);
    if (this.knownMultiWordMakes.has(canonicalFullInput)) {
      return { make: normalized };
    }

    for (let makeTokenCount = parts.length - 1; makeTokenCount >= 1; makeTokenCount -= 1) {
      const makeCandidate = parts.slice(0, makeTokenCount).join(" ");
      const canonicalCandidate = this.canonicalizeMake(makeCandidate);
      if (!this.knownMultiWordMakes.has(canonicalCandidate)) {
        continue;
      }

      return {
        make: makeCandidate,
        model: parts.slice(makeTokenCount).join(" "),
      };
    }

    return {
      make: parts.slice(0, -1).join(" "),
      model: parts.at(-1),
    };
  }

  mapVehicleCategory(value: VehicleType | undefined): { vehicleType?: VehicleType } {
    if (!value) {
      return {};
    }
    return { vehicleType: value };
  }

  buildInterpretationFromExtracted(extracted: ExtractedAiSearchParams): string {
    const vehicleParts = [
      extracted.color,
      extracted.make,
      extracted.model,
      extracted.vehicleType?.toLowerCase().replaceAll("_", " "),
      extracted.serviceTier?.toLowerCase().replaceAll("_", " "),
    ].filter(Boolean);

    const dateParts = [extracted.from, extracted.to].filter(Boolean);
    const summary = [
      vehicleParts.length > 0 ? `Looking for: ${vehicleParts.join(" ")}` : null,
      dateParts.length > 0 ? `Dates: ${dateParts.join(" to ")}` : null,
      extracted.bookingType ? `Type: ${extracted.bookingType}` : null,
      extracted.pickupLocation ? `Pickup: ${extracted.pickupLocation}` : null,
      extracted.dropoffLocation ? `Drop-off: ${extracted.dropoffLocation}` : null,
    ].filter(Boolean);

    return summary.join(" • ");
  }

  buildExactQuery(extracted: ExtractedAiSearchParams): CarSearchQueryDto {
    const query = this.buildTemporalQuery(extracted);

    if (extracted.color) query.color = extracted.color;
    if (extracted.make) query.make = extracted.make;
    if (extracted.model) query.model = extracted.model;
    if (extracted.vehicleType) query.vehicleType = extracted.vehicleType;
    if (extracted.serviceTier) query.serviceTier = extracted.serviceTier;

    return query;
  }

  buildAlternativeQueries(extracted: ExtractedAiSearchParams): CarSearchQueryDto[] {
    const base = this.buildTemporalQuery(extracted);
    const queries: CarSearchQueryDto[] = [];

    if (extracted.make || extracted.model) {
      queries.push(this.mergeQuery(base, { make: extracted.make, model: extracted.model }));
    }

    if (extracted.color) {
      queries.push(
        this.mergeQuery(base, {
          color: extracted.color,
          vehicleType: extracted.vehicleType,
          serviceTier: extracted.serviceTier,
        }),
      );
    }

    if (extracted.vehicleType || extracted.serviceTier) {
      queries.push(
        this.mergeQuery(base, {
          vehicleType: extracted.vehicleType,
          serviceTier: extracted.serviceTier,
        }),
      );
    }

    if (extracted.make) {
      queries.push(this.mergeQuery(base, { make: extracted.make }));
    }

    queries.push(base);
    return this.dedupeQueries(queries);
  }

  private buildTemporalQuery(extracted: ExtractedAiSearchParams): CarSearchQueryDto {
    const query: CarSearchQueryDto = {
      page: 1,
      limit: this.maxSearchCandidates,
    };

    const fromDate = parseSearchDate(extracted.from);
    if (fromDate) query.from = fromDate;
    const toDate = parseSearchDate(extracted.to);
    if (toDate) query.to = toDate;

    const bookingType = normalizeBookingType(extracted.bookingType);
    if (bookingType) query.bookingType = bookingType;
    if (extracted.pickupTime) query.pickupTime = extracted.pickupTime;
    if (extracted.flightNumber) query.flightNumber = extracted.flightNumber;

    return query;
  }

  private mergeQuery(
    base: CarSearchQueryDto,
    overrides: Partial<Record<keyof CarSearchQueryDto, unknown>>,
  ): CarSearchQueryDto {
    const defined = Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v != null),
    ) as Partial<CarSearchQueryDto>;
    return { ...base, ...defined };
  }

  private dedupeQueries(queries: CarSearchQueryDto[]): CarSearchQueryDto[] {
    const seen = new Set<string>();
    return queries.filter((query) => {
      const key = JSON.stringify({
        page: query.page,
        limit: query.limit,
        color: query.color ?? null,
        make: query.make ?? null,
        model: query.model ?? null,
        vehicleType: query.vehicleType ?? null,
        serviceTier: query.serviceTier ?? null,
        from: query.from?.toISOString() ?? null,
        to: query.to?.toISOString() ?? null,
        bookingType: query.bookingType ?? null,
        pickupTime: query.pickupTime ?? null,
        flightNumber: query.flightNumber ?? null,
      });

      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
  private canonicalizeMake(value: string): string {
    return value.toLowerCase().replaceAll("-", " ").replaceAll(/\s+/g, " ").trim();
  }
}
