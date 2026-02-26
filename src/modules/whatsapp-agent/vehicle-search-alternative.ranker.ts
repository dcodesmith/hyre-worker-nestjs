import type { ExtractedAiSearchParams } from "../ai-search/ai-search.interface";
import type { SearchCarDto } from "../car/dto/car-search.dto";
import type {
  VehicleSearchAlternative,
  VehicleSearchAlternativeReason,
  VehicleSearchOption,
} from "./whatsapp-agent.interface";

export class VehicleSearchAlternativeRanker {
  constructor(
    private readonly maxExactMatches: number,
    private readonly maxAlternatives: number,
  ) {}

  mapCarToOption(car: SearchCarDto): VehicleSearchOption {
    return {
      id: car.id,
      make: car.make,
      model: car.model,
      name: `${car.make} ${car.model}`,
      color: car.color,
      vehicleType: car.vehicleType,
      serviceTier: car.serviceTier,
      imageUrl: car.images[0]?.url ?? null,
      rates: {
        day: car.dayRate,
        night: car.nightRate,
        fullDay: car.fullDayRate,
        airportPickup: car.airportPickupRate,
      },
    };
  }

  selectExactMatches(
    candidates: VehicleSearchOption[],
    extracted: ExtractedAiSearchParams,
  ): VehicleSearchOption[] {
    return candidates
      .filter((candidate) => this.isExactMatch(candidate, extracted))
      .slice(0, this.maxExactMatches);
  }

  rankAlternatives(
    options: VehicleSearchOption[],
    extracted: ExtractedAiSearchParams,
  ): VehicleSearchAlternative[] {
    const deduped = this.dedupeById(options);
    const priceReference = this.resolveTargetDayRate(deduped, extracted);
    return deduped
      .filter((option) => !this.isExactMatch(option, extracted))
      .map((option) => {
        const score = this.computeAlternativeScore(option, extracted, priceReference);
        const reason = this.resolveAlternativeReason(option, extracted, priceReference);
        return { ...option, score, reason };
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (priceReference != null) {
          const leftDiff = Math.abs(left.rates.day - priceReference);
          const rightDiff = Math.abs(right.rates.day - priceReference);
          if (leftDiff !== rightDiff) {
            return leftDiff - rightDiff;
          }
        }
        if (left.rates.day !== right.rates.day) {
          return left.rates.day - right.rates.day;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, this.maxAlternatives);
  }

  isExactMatch(option: VehicleSearchOption, extracted: ExtractedAiSearchParams): boolean {
    if (extracted.make && !this.isTextMatch(option.make, extracted.make)) {
      return false;
    }
    if (extracted.model && !this.isTextMatch(option.model, extracted.model)) {
      return false;
    }
    if (extracted.color && !this.isTextMatch(option.color, extracted.color)) {
      return false;
    }
    if (extracted.vehicleType && option.vehicleType !== extracted.vehicleType) {
      return false;
    }
    if (extracted.serviceTier && option.serviceTier !== extracted.serviceTier) {
      return false;
    }
    return true;
  }

  private isTextMatch(actual: string | null, expected: string): boolean {
    const normalizedActual = actual?.trim().toLowerCase() ?? "";
    const normalizedExpected = expected.trim().toLowerCase();
    if (!normalizedActual || !normalizedExpected) {
      return false;
    }
    return (
      normalizedActual.includes(normalizedExpected) || normalizedExpected.includes(normalizedActual)
    );
  }

  private dedupeById(options: VehicleSearchOption[]): VehicleSearchOption[] {
    const seen = new Set<string>();
    return options.filter((option) => {
      if (seen.has(option.id)) {
        return false;
      }
      seen.add(option.id);
      return true;
    });
  }

  private computeAlternativeScore(
    option: VehicleSearchOption,
    extracted: ExtractedAiSearchParams,
    priceReference: number | null,
  ): number {
    const match = this.resolveMatchSignal(option, extracted);
    const isPriceAligned = this.isWithinPriceBand(option.rates.day, priceReference);
    return (
      (match.model ? 40 : 0) +
      (match.make ? 25 : 0) +
      (match.color ? 20 : 0) +
      (match.vehicleType ? 15 : 0) +
      (match.serviceTier ? 10 : 0) +
      (isPriceAligned ? 8 : 0)
    );
  }

  private resolveAlternativeReason(
    option: VehicleSearchOption,
    extracted: ExtractedAiSearchParams,
    priceReference: number | null,
  ): VehicleSearchAlternativeReason {
    const match = this.resolveMatchSignal(option, extracted);
    if (match.model && extracted.color && !match.color) {
      return "SAME_MODEL_DIFFERENT_COLOR";
    }
    if (match.color && (match.vehicleType || match.serviceTier)) {
      return "SAME_COLOR_SIMILAR_CLASS";
    }
    if (match.vehicleType || match.serviceTier) {
      return "SIMILAR_CLASS";
    }
    if (this.isWithinPriceBand(option.rates.day, priceReference)) {
      return "SIMILAR_PRICE_RANGE";
    }
    return "CLOSEST_AVAILABLE";
  }

  private resolveMatchSignal(option: VehicleSearchOption, extracted: ExtractedAiSearchParams) {
    return {
      make: Boolean(extracted.make && this.isTextMatch(option.make, extracted.make)),
      model: Boolean(extracted.model && this.isTextMatch(option.model, extracted.model)),
      color: Boolean(extracted.color && this.isTextMatch(option.color, extracted.color)),
      vehicleType: Boolean(extracted.vehicleType && option.vehicleType === extracted.vehicleType),
      serviceTier: Boolean(extracted.serviceTier && option.serviceTier === extracted.serviceTier),
    };
  }

  private resolveTargetDayRate(
    options: VehicleSearchOption[],
    extracted: ExtractedAiSearchParams,
  ): number | null {
    const sameModel = options.filter(
      (option) =>
        Boolean(extracted.make && this.isTextMatch(option.make, extracted.make)) &&
        Boolean(extracted.model && this.isTextMatch(option.model, extracted.model)),
    );
    if (sameModel.length > 0) {
      return this.meanDayRate(sameModel);
    }

    const sameClass = options.filter(
      (option) =>
        Boolean(extracted.vehicleType && option.vehicleType === extracted.vehicleType) ||
        Boolean(extracted.serviceTier && option.serviceTier === extracted.serviceTier),
    );
    if (sameClass.length > 0) {
      return this.meanDayRate(sameClass);
    }

    if (options.length === 0) {
      return null;
    }
    return this.meanDayRate(options);
  }

  private meanDayRate(options: VehicleSearchOption[]): number {
    const total = options.reduce((sum, option) => sum + option.rates.day, 0);
    return Math.round(total / options.length);
  }

  private isWithinPriceBand(dayRate: number, targetDayRate: number | null): boolean {
    if (targetDayRate == null || targetDayRate <= 0) {
      return false;
    }
    const maxDelta = targetDayRate * 0.15;
    return Math.abs(dayRate - targetDayRate) <= maxDelta;
  }
}
