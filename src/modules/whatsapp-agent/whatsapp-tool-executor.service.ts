import { Injectable, Logger } from "@nestjs/common";
import type { BookingType } from "@prisma/client";
import type { ExtractedAiSearchParams } from "../ai-search/ai-search.interface";
import { AiSearchService } from "../ai-search/ai-search.service";
import { CarSearchService } from "../car/car-search.service";
import type { CarSearchQueryDto } from "../car/dto/car-search.dto";
import { VehicleSearchToolResult } from "./whatsapp-agent.interface";

@Injectable()
export class WhatsAppToolExecutorService {
  private readonly logger = new Logger(WhatsAppToolExecutorService.name);
  private readonly maxOptions = 3;

  constructor(
    private readonly aiSearchService: AiSearchService,
    private readonly carSearchService: CarSearchService,
  ) {}

  async searchVehiclesFromMessage(message: string): Promise<VehicleSearchToolResult | null> {
    const content = message.trim();
    if (!content) {
      return null;
    }

    try {
      const aiSearch = await this.aiSearchService.search(content);
      const extracted = aiSearch.raw;
      if (!this.hasSearchSignal(extracted)) {
        return null;
      }

      const query = this.buildCarSearchQuery(extracted);
      const results = await this.carSearchService.searchCars(query);

      return {
        interpretation: aiSearch.interpretation,
        extracted,
        options: results.cars.slice(0, this.maxOptions).map((car) => ({
          id: car.id,
          name: `${car.make} ${car.model}`,
          color: car.color,
          imageUrl: car.images[0]?.url ?? null,
          rates: {
            day: car.dayRate,
            night: car.nightRate,
            fullDay: car.fullDayRate,
            airportPickup: car.airportPickupRate,
          },
        })),
      };
    } catch (error) {
      this.logger.warn("Tool search flow failed for WhatsApp message", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private hasSearchSignal(extracted: ExtractedAiSearchParams): boolean {
    return Boolean(
      extracted.color ||
        extracted.make ||
        extracted.model ||
        extracted.vehicleType ||
        extracted.serviceTier ||
        extracted.from ||
        extracted.to ||
        extracted.bookingType ||
        extracted.pickupTime ||
        extracted.flightNumber,
    );
  }

  private buildCarSearchQuery(extracted: ExtractedAiSearchParams): CarSearchQueryDto {
    const query: CarSearchQueryDto = {
      page: 1,
      limit: this.maxOptions,
    };

    if (extracted.color) query.color = extracted.color;
    if (extracted.make) query.make = extracted.make;
    if (extracted.model) query.model = extracted.model;
    if (extracted.vehicleType) query.vehicleType = extracted.vehicleType;
    if (extracted.serviceTier) query.serviceTier = extracted.serviceTier;

    if (extracted.from) {
      const fromDate = new Date(extracted.from);
      if (!Number.isNaN(fromDate.getTime())) query.from = fromDate;
    }
    if (extracted.to) {
      const toDate = new Date(extracted.to);
      if (!Number.isNaN(toDate.getTime())) query.to = toDate;
    }

    if (extracted.bookingType) query.bookingType = extracted.bookingType as BookingType;
    if (extracted.pickupTime) query.pickupTime = extracted.pickupTime;
    if (extracted.flightNumber) query.flightNumber = extracted.flightNumber;

    return query;
  }
}
