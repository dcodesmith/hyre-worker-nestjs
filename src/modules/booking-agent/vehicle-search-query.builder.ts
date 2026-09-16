import type { ExtractedAiSearchParams } from "../ai-search/ai-search.interface";
import type { CarSearchQueryDto } from "../car/dto/car-search.dto";
import { normalizeBookingType, parseSearchDate } from "./vehicle-search-precondition.policy";

export class VehicleSearchQueryBuilder {
  constructor(private readonly maxSearchCandidates: number) {}

  buildExactQuery(extracted: ExtractedAiSearchParams): CarSearchQueryDto {
    const query = this.buildTemporalQuery(extracted);

    if (extracted.color) query.color = extracted.color;
    if (extracted.make) query.make = [extracted.make];
    if (extracted.model) query.model = extracted.model;
    if (extracted.vehicleType) query.vehicleType = [extracted.vehicleType];
    if (extracted.serviceTier) query.serviceTier = [extracted.serviceTier];

    return query;
  }

  buildAlternativeQueries(extracted: ExtractedAiSearchParams): CarSearchQueryDto[] {
    const base = this.buildTemporalQuery(extracted);
    const queries: CarSearchQueryDto[] = [];

    const asList = (value: string | undefined) => (value ? [value] : undefined);

    if (extracted.make || extracted.model) {
      queries.push(this.mergeQuery(base, { make: asList(extracted.make), model: extracted.model }));
    }

    if (extracted.color) {
      queries.push(
        this.mergeQuery(base, {
          color: extracted.color,
          vehicleType: asList(extracted.vehicleType),
          serviceTier: asList(extracted.serviceTier),
        }),
      );
    }

    if (extracted.vehicleType || extracted.serviceTier) {
      queries.push(
        this.mergeQuery(base, {
          vehicleType: asList(extracted.vehicleType),
          serviceTier: asList(extracted.serviceTier),
        }),
      );
    }

    if (extracted.make) {
      queries.push(this.mergeQuery(base, { make: asList(extracted.make) }));
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
}
