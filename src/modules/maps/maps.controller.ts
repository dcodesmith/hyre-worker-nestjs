import { Controller, Get, UseGuards } from "@nestjs/common";
import { ZodQuery } from "../../common/decorators/zod-validation.decorator";
import {
  type CalculateTripDurationQueryDto,
  calculateTripDurationQuerySchema,
} from "./dto/calculate-trip-duration.dto";
import { MapsService } from "./maps.service";
import { TripDurationThrottlerGuard } from "./maps-throttler.guard";

@Controller("api")
export class MapsController {
  constructor(private readonly mapsService: MapsService) {}

  @Get("calculate-trip-duration")
  @UseGuards(TripDurationThrottlerGuard)
  async calculateTripDuration(
    @ZodQuery(calculateTripDurationQuerySchema) query: CalculateTripDurationQueryDto,
  ) {
    return this.mapsService.calculateAirportTripDuration(query.destination);
  }
}
