import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { AddonsService } from "../../addons/addons.service";
import type { AuthSession } from "../../auth/guards/session.guard";
import { BookingPricingPreviewService } from "../../booking/booking-pricing-preview.service";
import { WhatsAppPersistenceService } from "../whatsapp/whatsapp-persistence.service";
import { buildBookingInputFromDraft } from "./booking-orchestrator";
import type { BookingAgentState } from "./conversation.interface";

@Injectable()
export class PrepareQuoteAction {
  constructor(
    private readonly addonsService: AddonsService,
    private readonly bookingPricingPreviewService: BookingPricingPreviewService,
    private readonly whatsAppPersistenceService: WhatsAppPersistenceService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PrepareQuoteAction.name);
  }

  async run(state: BookingAgentState): Promise<Partial<BookingAgentState>> {
    if (!state.selectedOption || !state.draft.bookingType) {
      return {
        error: "Choose a vehicle before reviewing the final quote.",
        stage: "collecting",
      };
    }

    try {
      if (state.stage === "selecting_addons") {
        const existingAddons = state.availableAddons ?? [];
        const addonSelectionIndex = state.addonSelectionIndex ?? 0;
        const availableAddons =
          existingAddons.length > 0
            ? existingAddons
            : (await this.addonsService.listPublic(state.draft.bookingType)).addons;

        if (addonSelectionIndex < availableAddons.length) {
          return { availableAddons, stage: "selecting_addons" };
        }

        const fuelCandidate = await this.preview(state, true, 0);
        if (fuelCandidate.fuelUpgradeCost > 0) {
          return {
            availableAddons,
            pricingPreview: fuelCandidate,
            stage: "selecting_fuel",
          };
        }

        return this.offerCreditsOrConfirm(state, fuelCandidate, availableAddons);
      }

      if (state.stage === "selecting_fuel") {
        const pricing = await this.preview(state, state.requiresFullTank ?? false, 0);
        return this.offerCreditsOrConfirm(state, pricing, state.availableAddons ?? []);
      }

      if (state.stage === "selecting_credits") {
        const pricing = await this.preview(
          state,
          state.requiresFullTank ?? false,
          state.useCredits ?? 0,
        );
        return {
          pricingPreview: pricing,
          stage: "confirming",
        };
      }

      if (state.stage === "confirming" && !state.pricingPreview) {
        const pricing = await this.preview(
          state,
          state.requiresFullTank ?? true,
          Math.max(0, state.useCredits ?? 0),
        );
        return {
          pricingPreview: pricing,
          stage: "confirming",
        };
      }

      return {};
    } catch (error) {
      this.logger.error(
        {
          conversationId: state.conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to prepare WhatsApp booking quote",
      );
      return {
        error: "I couldn't prepare the final quote. Please try again or ask for an agent.",
        stage: "confirming",
      };
    }
  }

  private async offerCreditsOrConfirm(
    state: BookingAgentState,
    pricing: NonNullable<BookingAgentState["pricingPreview"]>,
    availableAddons: NonNullable<BookingAgentState["availableAddons"]>,
  ): Promise<Partial<BookingAgentState>> {
    const linkState = await this.whatsAppPersistenceService.getConversationLinkState(
      state.conversationId,
    );
    const isLinked = linkState.linkStatus === "LINKED" && linkState.linkedUserId !== null;

    return {
      availableAddons,
      pricingPreview: pricing,
      useCredits: 0,
      stage: isLinked && pricing.creditsApplicable > 0 ? "selecting_credits" : "confirming",
    };
  }

  private async preview(state: BookingAgentState, requiresFullTank: boolean, useCredits: number) {
    const selectedOption = state.selectedOption;
    if (!selectedOption) {
      throw new Error("Selected vehicle is missing");
    }

    const { input } = buildBookingInputFromDraft(
      state.draft,
      selectedOption,
      {
        guestEmail: "whatsapp-preview@tripdly.com",
        guestName: "WhatsApp Customer",
        guestPhone: "+10000000000",
      },
      {
        addonIds: state.selectedAddonIds ?? [],
        requiresFullTank,
        useCredits,
        expectedTotalAmount: "0",
      },
    );
    const linkState = await this.whatsAppPersistenceService.getConversationLinkState(
      state.conversationId,
    );
    const sessionUser =
      linkState.linkStatus === "LINKED" && linkState.linkedUserId
        ? ({ id: linkState.linkedUserId } as AuthSession["user"])
        : null;

    return this.bookingPricingPreviewService.preview(
      {
        carId: input.carId,
        bookingType: input.bookingType,
        startDate: input.startDate,
        endDate: input.endDate,
        pickupTime: input.pickupTime,
        addonIds: input.addonIds,
        requiresFullTank,
        useCredits,
      },
      sessionUser,
    );
  }
}
