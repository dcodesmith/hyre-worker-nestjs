import { Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ZodBody, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import type { FlightAwareWebhookDto } from "./dto/flightaware-webhook.dto";
import { flightAwareWebhookSchema } from "./dto/flightaware-webhook.dto";
import type { SearchFlightQueryDto } from "./dto/search-flight.dto";
import { searchFlightQuerySchema } from "./dto/search-flight.dto";
import { type FlightAwareWebhookResult, type SearchFlightResult } from "./flightaware.interface";
import { FlightAwareService } from "./flightaware.service";
import { FlightAwareWebhookService } from "./flightaware-webhook.service";
import { FlightAwareWebhookGuard } from "./guards/flightaware-webhook.guard";

@Controller("api")
export class FlightAwareController {
  constructor(
    private readonly flightAwareService: FlightAwareService,
    private readonly flightAwareWebhookService: FlightAwareWebhookService,
  ) {}

  @Get("search-flight")
  async searchFlight(
    @ZodQuery(searchFlightQuerySchema) query: SearchFlightQueryDto,
  ): Promise<SearchFlightResult> {
    return this.flightAwareService.searchAirportPickupFlight(query.flightNumber, query.date);
  }

  @Post("webhooks/flightaware")
  @HttpCode(HttpStatus.OK)
  @UseGuards(FlightAwareWebhookGuard)
  async handleFlightAwareWebhook(
    @ZodBody(flightAwareWebhookSchema) payload: FlightAwareWebhookDto,
  ): Promise<FlightAwareWebhookResult> {
    return this.flightAwareWebhookService.handleWebhook(payload);
  }
}
