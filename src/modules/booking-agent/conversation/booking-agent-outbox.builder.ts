import {
  BOOKING_AGENT_BUTTON_ID,
  BOOKING_AGENT_OUTBOUND_MODE,
  BOOKING_CONFIRMATION_CONTENT_SID,
  CHECKOUT_LINK_CONTENT_SID,
  VEHICLE_CARD_CONTENT_SID,
} from "./conversation.const";
import type {
  AgentResponse,
  BookingAgentOutboxItem,
  BookingStage,
  VehicleSearchOption,
} from "./conversation.interface";

type OutboxStateContext = {
  conversationId: string;
  inboundMessageId: string;
  stage: BookingStage;
  paymentLink: string | null;
  selectedOption: VehicleSearchOption | null;
  availableOptions: VehicleSearchOption[];
};

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
  return `₦${vehicle.estimatedTotalInclVat.toLocaleString()}`;
}

function isConfirmationResponse(response: AgentResponse): boolean {
  return Boolean(
    response.interactive?.buttons?.some((button) => button.id === BOOKING_AGENT_BUTTON_ID.CONFIRM),
  );
}

function removeConfirmationPrompt(text: string): string {
  return text.replace(/\n\nReady to confirm this booking\?$/, "");
}

export function buildOutboxItems(
  state: OutboxStateContext,
  response: AgentResponse,
): BookingAgentOutboxItem[] {
  const outboxItems: BookingAgentOutboxItem[] = [];

  if (response.vehicleCards && response.vehicleCards.length > 0) {
    outboxItems.push({
      conversationId: state.conversationId,
      dedupeKey: `booking-agent:${state.inboundMessageId}:intro`,
      mode: BOOKING_AGENT_OUTBOUND_MODE.FREE_FORM,
      textBody: response.text,
    });

    response.vehicleCards.forEach((card, index) => {
      const vehicle = state.availableOptions.find((option) => option.id === card.vehicleId);
      if (!vehicle) {
        return;
      }

      if (!card.imageUrl) {
        outboxItems.push({
          conversationId: state.conversationId,
          dedupeKey: `booking-agent:${state.inboundMessageId}:vehicle:${index}`,
          mode: BOOKING_AGENT_OUTBOUND_MODE.FREE_FORM,
          textBody: `${card.caption}\n\nReply "Option ${index + 1}" to select this car.`,
        });
        return;
      }

      const priceLabel = formatPriceForTemplate(vehicle);
      const templateVariables = {
        "1": `${vehicle.make} ${vehicle.model} · ${priceLabel}`,
        "2": priceLabel,
        "3": card.imageUrl,
        "4": "Select",
        "5": vehicle.id,
      } as const;

      outboxItems.push({
        conversationId: state.conversationId,
        dedupeKey: `booking-agent:${state.inboundMessageId}:vehicle:${index}`,
        mode: BOOKING_AGENT_OUTBOUND_MODE.TEMPLATE,
        templateName: VEHICLE_CARD_CONTENT_SID,
        templateVariables,
      });
    });

    // Fallback in case vehicle cards exist but no matching options were found.
    if (outboxItems.length > 1) {
      return outboxItems;
    }
  }

  if (state.stage === "confirming" && state.selectedOption && isConfirmationResponse(response)) {
    return [
      {
        conversationId: state.conversationId,
        dedupeKey: `booking-agent:${state.inboundMessageId}:confirmation`,
        mode: BOOKING_AGENT_OUTBOUND_MODE.TEMPLATE,
        textBody: removeConfirmationPrompt(response.text),
        templateName: BOOKING_CONFIRMATION_CONTENT_SID,
      },
    ];
  }

  if (state.stage === "awaiting_payment" && state.paymentLink) {
    const checkoutToken = extractCheckoutToken(state.paymentLink);

    if (!checkoutToken) {
      return [
        {
          conversationId: state.conversationId,
          dedupeKey: `booking-agent:${state.inboundMessageId}:payment-link-fallback`,
          mode: BOOKING_AGENT_OUTBOUND_MODE.FREE_FORM,
          textBody: `${response.text}\n\n${state.paymentLink}`,
          interactive: response.interactive,
        },
      ];
    }

    return [
      {
        conversationId: state.conversationId,
        dedupeKey: `booking-agent:${state.inboundMessageId}:payment-link`,
        mode: BOOKING_AGENT_OUTBOUND_MODE.TEMPLATE,
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
      dedupeKey: `booking-agent:${state.inboundMessageId}`,
      mode: BOOKING_AGENT_OUTBOUND_MODE.FREE_FORM,
      textBody: response.text,
      interactive: response.interactive,
    },
  ];
}
