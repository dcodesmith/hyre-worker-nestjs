import { Injectable } from "@nestjs/common";
import { formatInTimeZone } from "date-fns-tz";
import { PinoLogger } from "nestjs-pino";
import { BookingLegService } from "../../booking/booking-leg.service";
import { FlightAwareApiException, FlightAwareException } from "../../flightaware/flightaware.error";
import { FlightAwareService } from "../../flightaware/flightaware.service";
import { GooglePlacesService } from "../../maps/google-places.service";
import { MapsService } from "../../maps/maps.service";
import { getMissingRequiredFields } from "../booking-agent.helper";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import { clearDerivedAirportFields } from "./booking-rules";
import {
  BOOKING_AGENT_OUTBOUND_MODE,
  getBookingAgentServiceUnavailableMessage,
} from "./conversation.const";
import {
  type BookingAgentLocationValidationState,
  type BookingAgentState,
  type BookingDraft,
  convertToExtractedParams,
  createDefaultLocationValidationState,
  isAnyVehiclePreference,
  type LocationValidationState,
  type VehicleSearchOption,
} from "./conversation.interface";

@Injectable()
export class SearchAction {
  constructor(
    private readonly bookingAgentSearchService: BookingAgentSearchService,
    private readonly googlePlacesService: GooglePlacesService,
    private readonly flightAwareService: FlightAwareService,
    private readonly mapsService: MapsService,
    private readonly bookingLegService: BookingLegService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SearchAction.name);
  }

  async run(state: BookingAgentState): Promise<Partial<BookingAgentState>> {
    try {
      const validationState =
        state.draft.bookingType === "AIRPORT_PICKUP"
          ? { ...state, draft: clearDerivedAirportFields(state.draft) }
          : state;
      const validationResult = await this.validateAndNormalizeLocations(validationState);
      if (validationResult.earlyReturn) {
        return {
          ...validationResult.earlyReturn,
          draft: validationResult.draft,
          locationValidation: validationResult.locationValidation,
        };
      }

      const validatedState = {
        ...state,
        draft: validationResult.draft,
        locationValidation: validationResult.locationValidation,
      };
      let airportResult: Awaited<ReturnType<SearchAction["enrichAirportPickup"]>>;
      try {
        airportResult = await this.enrichAirportPickup(validatedState);
      } catch (error) {
        if (error instanceof FlightAwareException) {
          this.logger.info(
            {
              errorCode: error.getErrorCode(),
              flightNumber: validatedState.draft.flightNumber,
              pickupDate: validatedState.draft.pickupDate,
            },
            "Airport pickup flight validation rejected",
          );
          return {
            draft: clearDerivedAirportFields(validatedState.draft),
            stage: "collecting",
            availableOptions: [],
            lastShownOptions: [],
            error: null,
            statusMessage: error.message,
            locationValidation: validatedState.locationValidation,
          };
        }
        throw error;
      }
      const validatedDraft = airportResult.draft;
      const locationValidation = airportResult.locationValidation;

      if (
        this.shouldBlockSearchForInvalidLocation(
          validatedDraft.pickupLocation,
          locationValidation.pickup,
        )
      ) {
        return {
          draft: validatedDraft,
          stage: "collecting",
          availableOptions: [],
          lastShownOptions: [],
          statusMessage: this.buildLocationFailureStatusMessage(
            validatedDraft.pickupLocation,
            "pickup",
          ),
          locationValidation,
        };
      }

      if (
        this.shouldBlockSearchForInvalidLocation(
          validatedDraft.dropoffLocation,
          locationValidation.dropoff,
        )
      ) {
        return {
          draft: validatedDraft,
          stage: "collecting",
          availableOptions: [],
          lastShownOptions: [],
          statusMessage: this.buildLocationFailureStatusMessage(
            validatedDraft.dropoffLocation,
            "drop-off",
          ),
          locationValidation,
        };
      }

      const missingFields = getMissingRequiredFields(validatedDraft);
      if (missingFields.length > 0) {
        return {
          draft: validatedDraft,
          stage: "collecting",
          availableOptions: [],
          lastShownOptions: [],
          error: null,
          locationValidation,
        };
      }

      const extractedParams = convertToExtractedParams(validatedDraft);
      this.logger.info(
        {
          draft: validatedDraft,
          extractedParams,
        },
        "Search action executing",
      );
      const searchResult = await this.bookingAgentSearchService.searchVehiclesFromExtracted(
        extractedParams,
        "",
      );

      if (searchResult.precondition) {
        this.logger.warn(
          {
            precondition: searchResult.precondition,
            extractedParams,
          },
          "Search returned precondition",
        );
        return {
          draft: validatedDraft,
          availableOptions: [],
          lastShownOptions: [],
          stage: "collecting",
          error: null,
          statusMessage: searchResult.precondition.prompt,
          locationValidation,
        };
      }

      const hasStrictVehicleFilters = this.hasStrictVehicleFilters(validatedDraft);
      const allowAlternativeMatches = this.shouldAllowAlternativeMatches(state.preferences);
      const shouldSuppressAlternatives =
        searchResult.exactMatches.length === 0 &&
        searchResult.alternatives.length > 0 &&
        hasStrictVehicleFilters &&
        !allowAlternativeMatches;

      const options: VehicleSearchOption[] = shouldSuppressAlternatives
        ? []
        : [...searchResult.exactMatches, ...searchResult.alternatives].slice(0, 5);

      const newStage = options.length > 0 ? "presenting_options" : "collecting";

      this.logger.info(
        {
          exactMatchCount: searchResult.exactMatches.length,
          alternativeCount: searchResult.alternatives.length,
          totalOptions: options.length,
          newStage,
          optionDetails: options.map((o) => ({
            id: o.id,
            make: o.make,
            model: o.model,
            price: o.estimatedTotalInclVat,
          })),
        },
        "Search action completed",
      );

      const noResultsMessage = this.buildSearchStatusMessage({
        optionsCount: options.length,
        exactMatchCount: searchResult.exactMatches.length,
        alternativeCount: searchResult.alternatives.length,
        shouldSuppressAlternatives,
        draft: validatedDraft,
      });
      const statusMessage =
        [airportResult.statusMessage, noResultsMessage].filter(Boolean).join(" ") || null;

      return {
        draft: validatedDraft,
        availableOptions: options,
        lastShownOptions: options,
        stage: newStage,
        error: null,
        statusMessage,
        locationValidation,
      };
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Search action failed",
      );
      return {
        stage: "collecting",
        error: getBookingAgentServiceUnavailableMessage(),
        availableOptions: [],
        lastShownOptions: [],
        statusMessage:
          "I couldn't complete the car search right now. Please try again in a moment, and I'll search again.",
      };
    }
  }

  private async enrichAirportPickup(state: BookingAgentState): Promise<{
    draft: BookingDraft;
    locationValidation: BookingAgentLocationValidationState;
    statusMessage: string | null;
  }> {
    if (state.draft.bookingType !== "AIRPORT_PICKUP") {
      return {
        draft: state.draft,
        locationValidation: this.getLocationValidationState(state),
        statusMessage: null,
      };
    }

    const { flightNumber, pickupDate, dropoffLocation } = state.draft;
    if (!flightNumber || !pickupDate || !dropoffLocation) {
      return {
        draft: clearDerivedAirportFields(state.draft),
        locationValidation: this.getLocationValidationState(state),
        statusMessage: null,
      };
    }

    const { flight, warning } = await this.flightAwareService.searchAirportPickupFlight(
      flightNumber,
      pickupDate,
    );
    const arrivalTime = new Date(flight.arrivalTime);
    if (Number.isNaN(arrivalTime.getTime())) {
      throw new FlightAwareApiException("FlightAware returned invalid flight timing data");
    }

    const duration = await this.mapsService.calculateAirportTripDuration(dropoffLocation);
    const [leg] = this.bookingLegService.generateLegs({
      bookingType: "AIRPORT_PICKUP",
      startDate: arrivalTime,
      endDate: arrivalTime,
      flightArrivalTime: arrivalTime,
      driveTimeMinutes: duration.durationMinutes,
    });
    const pickupLocation = this.composeAirportPickupAddress(flight);
    const draft: BookingDraft = {
      ...state.draft,
      pickupDateTime: leg.legStartTime.toISOString(),
      dropoffDateTime: leg.legEndTime.toISOString(),
      pickupTime: formatInTimeZone(leg.legStartTime, "Africa/Lagos", "HH:mm"),
      pickupLocation,
      dropoffDate: formatInTimeZone(leg.legEndTime, "Africa/Lagos", "yyyy-MM-dd"),
    };
    delete draft.durationDays;

    const flightSummary = `Flight ${flight.flightNumber} arrives in Lagos at ${formatInTimeZone(arrivalTime, "Africa/Lagos", "h:mm a")}. Pickup will be around ${formatInTimeZone(leg.legStartTime, "Africa/Lagos", "h:mm a")} from ${pickupLocation}.`;
    return {
      draft,
      locationValidation: {
        ...this.getLocationValidationState(state),
        pickup: {
          status: "valid",
          lastValidatedInput: pickupLocation,
          normalizedAddress: pickupLocation,
        },
      },
      statusMessage: warning ? `${warning} ${flightSummary}` : flightSummary,
    };
  }

  private composeAirportPickupAddress(
    flight: Awaited<ReturnType<FlightAwareService["searchAirportPickupFlight"]>>["flight"],
  ): string {
    const name = flight.destinationName?.trim();
    const city = flight.destinationCity?.trim();
    if (name && city) {
      return `${name}, ${city}`;
    }
    return (
      name || city || flight.destinationIATA?.trim() || flight.destination.trim() || "Lagos Airport"
    );
  }

  private shouldAllowAlternativeMatches(preferences: BookingAgentState["preferences"]): boolean {
    return Boolean(preferences.notes?.includes("show_alternatives"));
  }

  private hasStrictVehicleFilters(draft: BookingDraft): boolean {
    return Boolean(
      draft.color?.trim() ||
        (draft.vehicleType && !isAnyVehiclePreference(draft.vehicleType)) ||
        draft.serviceTier ||
        (draft.make?.trim() && !isAnyVehiclePreference(draft.make)) ||
        (draft.model?.trim() && !isAnyVehiclePreference(draft.model)),
    );
  }

  private buildSearchStatusMessage(input: {
    optionsCount: number;
    exactMatchCount: number;
    alternativeCount: number;
    shouldSuppressAlternatives: boolean;
    draft: BookingDraft;
  }): string | null {
    const { optionsCount, exactMatchCount, alternativeCount, shouldSuppressAlternatives, draft } =
      input;
    if (shouldSuppressAlternatives && alternativeCount > 0) {
      return `I couldn't find an exact match for ${this.buildVehicleConstraintLabel(draft)}. I found close alternatives instead - would you like me to show them?`;
    }

    if (optionsCount === 0) {
      return "No vehicles matching your criteria are available for the selected date. Would you like to try a different date, vehicle type, or booking type?";
    }

    if (exactMatchCount === 0) {
      return "I couldn't find an exact match, but I found close alternatives you can choose from.";
    }

    return null;
  }

  private buildVehicleConstraintLabel(draft: BookingDraft): string {
    const parts = [
      draft.color?.trim(),
      draft.vehicleType?.toLowerCase().replaceAll("_", " "),
      draft.serviceTier?.toLowerCase().replaceAll("_", " "),
    ]
      .filter(Boolean)
      .map(String);
    if (parts.length > 0) {
      return `a ${parts.join(" ")}`;
    }

    const makeModel = [draft.make, draft.model]
      .filter((value) => value?.trim() && !isAnyVehiclePreference(value))
      .join(" ");
    return makeModel ? `"${makeModel}"` : "your requested vehicle";
  }

  private shouldValidateLocationField(
    locationValue: string | undefined,
    validation: LocationValidationState,
  ): boolean {
    const normalizedInput = locationValue?.trim();
    if (!normalizedInput) {
      return false;
    }

    if (validation.lastValidatedInput !== normalizedInput) {
      return true;
    }

    return validation.status === "unvalidated";
  }

  private shouldBlockSearchForInvalidLocation(
    locationValue: string | undefined,
    validation: LocationValidationState,
  ): boolean {
    if (!locationValue?.trim()) {
      return false;
    }

    return validation.status === "invalid";
  }

  private buildLocationFailureStatusMessage(
    locationValue: string | undefined,
    locationLabel: "pickup" | "drop-off",
  ): string {
    const value = locationValue?.trim() || "that location";
    return this.buildFullAddressPrompt(value, locationLabel);
  }

  private resolveInvalidLocationStatus(): LocationValidationState["status"] {
    return "invalid";
  }

  private buildFullAddressPrompt(
    locationValue: string,
    locationLabel: "pickup" | "drop-off" = "pickup",
  ): string {
    const locationNoun = locationLabel === "pickup" ? "pickup address" : "drop-off address";
    return [
      `I couldn't confirm "${locationValue}" as a complete ${locationNoun}.`,
      "",
      `Please share the full ${locationNoun} (for example: building number + street, or a hotel/landmark name in Lagos).`,
    ].join("\n");
  }

  private getLocationValidationState(
    state: Pick<BookingAgentState, "locationValidation">,
  ): BookingAgentLocationValidationState {
    return state.locationValidation ?? createDefaultLocationValidationState();
  }

  private async validateAndNormalizeLocations(state: BookingAgentState): Promise<{
    draft: BookingDraft;
    locationValidation: BookingAgentLocationValidationState;
    earlyReturn?: Partial<BookingAgentState>;
  }> {
    const pickupResult = await this.validateAndNormalizePickupLocation(state);
    const dropoffResult = await this.validateAndNormalizeDropoffLocation(
      state,
      pickupResult.draft,
      pickupResult.locationValidation,
    );

    const earlyReturn = pickupResult.earlyReturn ?? dropoffResult.earlyReturn;

    return {
      draft: dropoffResult.draft,
      locationValidation: dropoffResult.locationValidation,
      earlyReturn,
    };
  }

  private async validateAndNormalizePickupLocation(state: BookingAgentState): Promise<{
    draft: BookingDraft;
    locationValidation: BookingAgentLocationValidationState;
    earlyReturn?: Partial<BookingAgentState>;
  }> {
    const locationValidation = this.getLocationValidationState(state);
    const pickupValidation = locationValidation.pickup;
    const shouldValidate = this.shouldValidateLocationField(
      state.draft.pickupLocation,
      pickupValidation,
    );

    if (!shouldValidate) {
      return { draft: state.draft, locationValidation };
    }

    const pickupInput = state.draft.pickupLocation?.trim() ?? "";
    const locationResult = await this.googlePlacesService.validateAddress(pickupInput);

    if (!locationResult.isValid) {
      const nextLocationValidation: BookingAgentLocationValidationState = {
        ...locationValidation,
        pickup: {
          status: this.resolveInvalidLocationStatus(),
          lastValidatedInput: pickupInput,
          normalizedAddress: null,
        },
      };
      return {
        draft: state.draft,
        locationValidation: nextLocationValidation,
        earlyReturn: this.buildInvalidPickupLocationResult(
          state,
          pickupInput,
          nextLocationValidation,
        ),
      };
    }

    if (!locationResult.normalizedAddress) {
      return { draft: state.draft, locationValidation };
    }

    const normalizedAddress = locationResult.normalizedAddress;
    const wasDropoffSameAsPickup = state.draft.dropoffLocation === state.draft.pickupLocation;
    const nextLocationValidation: BookingAgentLocationValidationState = {
      ...locationValidation,
      pickup: {
        status: "valid",
        lastValidatedInput: normalizedAddress,
        normalizedAddress,
      },
      ...(wasDropoffSameAsPickup && {
        dropoff: {
          status: "valid",
          lastValidatedInput: normalizedAddress,
          normalizedAddress,
        },
      }),
    };

    return {
      draft: {
        ...state.draft,
        pickupLocation: normalizedAddress,
        ...(wasDropoffSameAsPickup && {
          dropoffLocation: normalizedAddress,
        }),
      },
      locationValidation: nextLocationValidation,
    };
  }

  private async validateAndNormalizeDropoffLocation(
    state: BookingAgentState,
    draft: BookingDraft,
    locationValidation: BookingAgentLocationValidationState,
  ): Promise<{
    draft: BookingDraft;
    locationValidation: BookingAgentLocationValidationState;
    earlyReturn?: Partial<BookingAgentState>;
  }> {
    const pickupLocation = draft.pickupLocation?.trim();
    const dropoffLocation = draft.dropoffLocation?.trim();

    if (!dropoffLocation) {
      return { draft, locationValidation };
    }

    if (pickupLocation && pickupLocation === dropoffLocation) {
      if (locationValidation.pickup.status === "valid") {
        const normalizedAddress = locationValidation.pickup.normalizedAddress ?? pickupLocation;
        return {
          draft,
          locationValidation: {
            ...locationValidation,
            dropoff: {
              status: "valid",
              lastValidatedInput: normalizedAddress,
              normalizedAddress,
            },
          },
        };
      }

      if (
        locationValidation.pickup.status === "invalid" &&
        locationValidation.pickup.lastValidatedInput === pickupLocation
      ) {
        return {
          draft,
          locationValidation: {
            ...locationValidation,
            dropoff: {
              status: "invalid",
              lastValidatedInput: dropoffLocation,
              normalizedAddress: null,
            },
          },
        };
      }
    }

    if (!this.shouldValidateLocationField(dropoffLocation, locationValidation.dropoff)) {
      return { draft, locationValidation };
    }

    const locationResult = await this.googlePlacesService.validateAddress(dropoffLocation);
    if (!locationResult.isValid) {
      const nextLocationValidation: BookingAgentLocationValidationState = {
        ...locationValidation,
        dropoff: {
          status: this.resolveInvalidLocationStatus(),
          lastValidatedInput: dropoffLocation,
          normalizedAddress: null,
        },
      };
      return {
        draft,
        locationValidation: nextLocationValidation,
        earlyReturn: this.buildInvalidDropoffLocationResult(
          state,
          dropoffLocation,
          nextLocationValidation,
        ),
      };
    }

    if (!locationResult.normalizedAddress) {
      return { draft, locationValidation };
    }

    const normalizedAddress = locationResult.normalizedAddress;
    return {
      draft: {
        ...draft,
        dropoffLocation: normalizedAddress,
      },
      locationValidation: {
        ...locationValidation,
        dropoff: {
          status: "valid",
          lastValidatedInput: normalizedAddress,
          normalizedAddress,
        },
      },
    };
  }

  private buildInvalidPickupLocationResult(
    state: BookingAgentState,
    pickupLocation: string,
    locationValidation: BookingAgentLocationValidationState,
  ): Partial<BookingAgentState> {
    const suggestionText = this.buildFullAddressPrompt(pickupLocation || "that location", "pickup");

    return {
      stage: "collecting",
      locationValidation: {
        ...locationValidation,
        pickup: {
          status: this.resolveInvalidLocationStatus(),
          lastValidatedInput: pickupLocation,
          normalizedAddress: null,
        },
      },
      response: { text: suggestionText },
      error: null,
      outboxItems: [
        {
          conversationId: state.conversationId,
          dedupeKey: `booking-agent:${state.inboundMessageId}:address-checking`,
          mode: BOOKING_AGENT_OUTBOUND_MODE.FREE_FORM,
          textBody: "Thanks - I'm checking that pickup address on Google Maps now...",
        },
        {
          conversationId: state.conversationId,
          dedupeKey: `booking-agent:${state.inboundMessageId}:address-suggestions`,
          mode: BOOKING_AGENT_OUTBOUND_MODE.FREE_FORM,
          textBody: suggestionText,
        },
      ],
    };
  }

  private buildInvalidDropoffLocationResult(
    state: BookingAgentState,
    dropoffLocation: string,
    locationValidation: BookingAgentLocationValidationState,
  ): Partial<BookingAgentState> {
    const suggestionText = this.buildFullAddressPrompt(dropoffLocation, "drop-off");

    return {
      stage: "collecting",
      locationValidation: {
        ...locationValidation,
        dropoff: {
          status: this.resolveInvalidLocationStatus(),
          lastValidatedInput: dropoffLocation,
          normalizedAddress: null,
        },
      },
      response: { text: suggestionText },
      error: null,
      outboxItems: [
        {
          conversationId: state.conversationId,
          dedupeKey: `booking-agent:${state.inboundMessageId}:dropoff-address-checking`,
          mode: BOOKING_AGENT_OUTBOUND_MODE.FREE_FORM,
          textBody: "Thanks - I'm checking that drop-off address on Google Maps now...",
        },
        {
          conversationId: state.conversationId,
          dedupeKey: `booking-agent:${state.inboundMessageId}:dropoff-address-suggestions`,
          mode: BOOKING_AGENT_OUTBOUND_MODE.FREE_FORM,
          textBody: suggestionText,
        },
      ],
    };
  }
}
