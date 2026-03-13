import { Logger } from "@nestjs/common";
import {
  CHECKOUT_LINK_CONTENT_SID,
  LANGGRAPH_OUTBOUND_MODE,
  VEHICLE_CARD_CONTENT_SID,
} from "./langgraph.const";
import type {
  AgentResponse,
  BookingStage,
  LangGraphOutboxItem,
  VehicleCard,
  VehicleSearchOption,
} from "./langgraph.interface";

type OutboxStateContext = {
  conversationId: string;
  inboundMessageId: string;
  stage: BookingStage;
  paymentLink: string | null;
  selectedOption: VehicleSearchOption | null;
  availableOptions: VehicleSearchOption[];
};

const logger = new Logger("LangGraphOutboxBuilder");

function extractCheckoutToken(checkoutUrl: string): string | null {
  try {
    const url = new URL(checkoutUrl);
    const match = /\/pay\/([^/]+)\/?$/.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizePriceLabel(price: string): string {
  return /\bincl\.\s*VAT\b/i.test(price) ? price : `${price} incl. VAT`;
}

function extractPriceFromCardCaption(card: VehicleCard): string | null {
  const match = /₦[\d,]+(?:\.\d+)?(?:\s*incl\.\s*VAT)?/i.exec(card.caption);
  if (!match?.[0]) {
    return null;
  }
  return normalizePriceLabel(match[0].trim());
}

function formatPriceForTemplate(vehicle: VehicleSearchOption, card: VehicleCard): string {
  if (vehicle.estimatedTotalInclVat === undefined) {
    return extractPriceFromCardCaption(card) ?? "Price unavailable";
  }
  return normalizePriceLabel(`₦${vehicle.estimatedTotalInclVat.toLocaleString()}`);
}

export function buildOutboxItems(
  state: OutboxStateContext,
  response: AgentResponse,
): LangGraphOutboxItem[] {
  const outboxItems: LangGraphOutboxItem[] = [];

  if (response.vehicleCards && response.vehicleCards.length > 0) {
    outboxItems.push({
      conversationId: state.conversationId,
      dedupeKey: `langgraph:${state.inboundMessageId}:intro`,
      mode: LANGGRAPH_OUTBOUND_MODE.FREE_FORM,
      textBody: response.text,
    });

    response.vehicleCards.forEach((card, index) => {
      const vehicle = state.availableOptions.find((option) => option.id === card.vehicleId);
      if (!vehicle) {
        logger.debug("Skipping vehicle card with missing option reference", {
          index,
          vehicleId: card.vehicleId,
          card,
          availableOptionIds: state.availableOptions.map((option) => option.id),
        });
        return;
      }

      const priceLabel = formatPriceForTemplate(vehicle, card);
      const templateVariables = {
        "1": `${vehicle.make} ${vehicle.model}`,
        "2": priceLabel,
        "3": card.imageUrl ?? "",
        "4": "Select",
        "5": vehicle.id,
      } as const;

      logger.log(
        {
          conversationId: state.conversationId,
          inboundMessageId: state.inboundMessageId,
          vehicleId: vehicle.id,
          templateName: VEHICLE_CARD_CONTENT_SID,
          templateVariables,
        },
        "Vehicle card template variables set",
      );

      outboxItems.push({
        conversationId: state.conversationId,
        dedupeKey: `langgraph:${state.inboundMessageId}:vehicle:${index}`,
        mode: LANGGRAPH_OUTBOUND_MODE.TEMPLATE,
        templateName: VEHICLE_CARD_CONTENT_SID,
        templateVariables,
      });
    });

    // Fallback in case vehicle cards exist but no matching options were found.
    if (outboxItems.length > 1) {
      return outboxItems;
    }
  }

  if (state.stage === "awaiting_payment" && state.paymentLink) {
    const checkoutToken = extractCheckoutToken(state.paymentLink);

    if (!checkoutToken) {
      return [
        {
          conversationId: state.conversationId,
          dedupeKey: `langgraph:${state.inboundMessageId}:payment-link-fallback`,
          mode: LANGGRAPH_OUTBOUND_MODE.FREE_FORM,
          textBody: `${response.text}\n\n${state.paymentLink}`,
          interactive: response.interactive,
        },
      ];
    }

    return [
      {
        conversationId: state.conversationId,
        dedupeKey: `langgraph:${state.inboundMessageId}:payment-link`,
        mode: LANGGRAPH_OUTBOUND_MODE.TEMPLATE,
        templateName: CHECKOUT_LINK_CONTENT_SID,
        templateVariables: {
          "1": response.text,
          "2": checkoutToken,
        },
      },
    ];
  }

  return [
    {
      conversationId: state.conversationId,
      dedupeKey: `langgraph:${state.inboundMessageId}`,
      mode: LANGGRAPH_OUTBOUND_MODE.FREE_FORM,
      textBody: response.text,
      interactive: response.interactive,
    },
  ];
}
