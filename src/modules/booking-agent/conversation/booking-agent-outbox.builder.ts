import { formatInTimeZone } from "date-fns-tz";
import {
  BOOKING_AGENT_BUTTON_ID,
  BOOKING_AGENT_OUTBOUND_MODE,
  BOOKING_CONFIRMATION_CONTENT_SID,
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
  holdExpiresAt: string | null;
  selectedOption: VehicleSearchOption | null;
  availableOptions: VehicleSearchOption[];
};

function formatPriceForTemplate(vehicle: VehicleSearchOption): string {
  const basePrice = vehicle.estimatedSubtotal ?? vehicle.rates.day;
  return `₦${basePrice.toLocaleString()}`;
}

function isConfirmationResponse(response: AgentResponse): boolean {
  return Boolean(
    response.interactive?.buttons?.some((button) => button.id === BOOKING_AGENT_BUTTON_ID.CONFIRM),
  );
}

function removeConfirmationPrompt(text: string): string {
  return text.replace(/\n\nReady to confirm this booking\?$/, "");
}

export type PayNowTemplateConfig = {
  contentSid?: string;
  checkoutHost: string;
};

function resolvePayNowTemplate(
  paymentLink: string,
  payNow: PayNowTemplateConfig,
): {
  contentSid: string;
  paymentId: string;
} | null {
  if (!payNow.contentSid) {
    return null;
  }

  try {
    const url = new URL(paymentLink);
    const paymentId = url.pathname.match(/^\/v3\/hosted\/pay\/([A-Za-z0-9_-]+)$/)?.[1];
    if (
      url.protocol !== "https:" ||
      url.hostname !== payNow.checkoutHost ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !paymentId
    ) {
      return null;
    }
    return { contentSid: payNow.contentSid, paymentId };
  } catch {
    return null;
  }
}

function formatReservationExpiry(holdExpiresAt: string): string | null {
  const expiry = new Date(holdExpiresAt);
  return Number.isNaN(expiry.getTime())
    ? null
    : formatInTimeZone(expiry, "Africa/Lagos", "do MMM yyyy 'at' h:mm aaa '(Lagos time)'");
}

export function buildOutboxItems(
  state: OutboxStateContext,
  response: AgentResponse,
  payNow: PayNowTemplateConfig = { checkoutHost: "" },
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
    const template = resolvePayNowTemplate(state.paymentLink, payNow);
    const expiry = state.holdExpiresAt ? formatReservationExpiry(state.holdExpiresAt) : null;
    if (template && expiry) {
      return [
        {
          conversationId: state.conversationId,
          dedupeKey: `booking-agent:${state.inboundMessageId}:payment-link`,
          mode: BOOKING_AGENT_OUTBOUND_MODE.TEMPLATE,
          templateName: template.contentSid,
          templateVariables: {
            "1": expiry,
            "2": template.paymentId,
          },
        },
      ];
    }

    const textBody = response.text.includes(state.paymentLink)
      ? response.text
      : `${response.text}\n\n${state.paymentLink}`;

    return [
      {
        conversationId: state.conversationId,
        dedupeKey: `booking-agent:${state.inboundMessageId}:payment-link`,
        mode: BOOKING_AGENT_OUTBOUND_MODE.FREE_FORM,
        textBody,
        interactive: response.interactive,
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
