import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ZodBody, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import {
  type PlacesAutocompleteQueryDto,
  placesAutocompleteQuerySchema,
} from "./dto/places-autocomplete.dto";
import { type ResolvePlaceBodyDto, resolvePlaceBodySchema } from "./dto/resolve-place.dto";
import { type ValidatePlaceBodyDto, validatePlaceBodySchema } from "./dto/validate-place.dto";
import { GooglePlacesService } from "./google-places.service";
import type {
  PlacesAutocompleteResponse,
  ResolvePlaceResponse,
  ValidatePlaceResponse,
} from "./maps.interface";
import { PlacesThrottlerGuard } from "./places-throttler.guard";

@Controller("api/places")
export class PlacesController {
  constructor(private readonly googlePlacesService: GooglePlacesService) {}

  @Get("autocomplete")
  @UseGuards(PlacesThrottlerGuard)
  async autocompleteAddress(
    @ZodQuery(placesAutocompleteQuerySchema) query: PlacesAutocompleteQueryDto,
  ): Promise<PlacesAutocompleteResponse> {
    return this.googlePlacesService.autocompleteAddress(query.input, {
      limit: query.limit,
      sessionToken: query.sessionToken,
    });
  }

  @Post("resolve")
  @UseGuards(PlacesThrottlerGuard)
  async resolvePlace(
    @ZodBody(resolvePlaceBodySchema) body: ResolvePlaceBodyDto,
  ): Promise<ResolvePlaceResponse> {
    return this.googlePlacesService.resolvePlace(body.placeId, {
      sessionToken: body.sessionToken,
    });
  }

  @Post("validate")
  @UseGuards(PlacesThrottlerGuard)
  async validatePlace(
    @ZodBody(validatePlaceBodySchema) body: ValidatePlaceBodyDto,
  ): Promise<ValidatePlaceResponse> {
    return this.googlePlacesService.validateAddress(body.input);
  }
}
