import { Controller, Get } from "@nestjs/common";
import { ZodQuery } from "../../common/decorators/zod-validation.decorator";
import {
  type CalculateTripDurationQueryDto,
  calculateTripDurationQuerySchema,
} from "./dto/calculate-trip-duration.dto";
import { MapsService } from "./maps.service";

@Controller("api")
export class MapsController {
  constructor(private readonly mapsService: MapsService) {}

  @Get("calculate-trip-duration")
  async calculateTripDuration(
    @ZodQuery(calculateTripDurationQuerySchema) query: CalculateTripDurationQueryDto,
  ) {
    return query.origin
      ? await this.mapsService.calculateDriveTime(query.origin, query.destination)
      : await this.mapsService.calculateAirportTripDuration(query.destination);
  }
}
