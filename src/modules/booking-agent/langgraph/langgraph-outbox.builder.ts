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

function formatPriceForTemplate(vehicle: VehicleSearchOption): string {
  if (vehicle.estimatedTotalInclVat === undefined) {
    return "Price unavailable";
  }
  return `₦${vehicle.estimatedTotalInclVat.toLocaleString()} incl. VAT`;
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

      outboxItems.push({
        conversationId: state.conversationId,
        dedupeKey: `langgraph:${state.inboundMessageId}:vehicle:${index}`,
        mode: LANGGRAPH_OUTBOUND_MODE.TEMPLATE,
        templateName: VEHICLE_CARD_CONTENT_SID,
        templateVariables: {
          "1": `${vehicle.make} ${vehicle.model}`,
          "2": formatPriceForTemplate(vehicle),
          "3": card.imageUrl ?? "",
          "4": "Select",
          "5": vehicle.id,
        },
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
