import type { BookingPricingPreviewResponseDto } from "../../booking/dto/pricing-preview.dto";
import type { BookingAgentState, VehicleSearchOption } from "./conversation.interface";

export function buildState(overrides?: Partial<BookingAgentState>): BookingAgentState {
  return {
    conversationId: "conv_test",
    inboundMessage: "I need a car tomorrow",
    inboundMessageId: "msg_1",
    customerId: null,
    stage: "collecting",
    turnCount: 1,
    messages: [],
    draft: {},
    availableOptions: [],
    lastShownOptions: [],
    selectedOption: null,
    holdId: null,
    holdExpiresAt: null,
    bookingId: null,
    paymentLink: null,
    preferences: {},
    response: null,
    outboxItems: [],
    extraction: null,
    nextAction: null,
    error: null,
    statusMessage: null,
    ...overrides,
  };
}

export function buildPricingPreview(
  overrides: Partial<BookingPricingPreviewResponseDto> = {},
): BookingPricingPreviewResponseDto {
  return {
    currency: "NGN",
    numberOfLegs: 1,
    discountCoverage: "NONE",
    segments: [],
    baseTotal: 150000,
    compareAtBaseTotal: 150000,
    addons: [],
    addonTotal: 0,
    fuelUpgradeCost: 0,
    platformFeeRatePercent: 0,
    platformFeeAmount: 0,
    compareAtPlatformFeeAmount: 0,
    subtotalBeforeDiscounts: 150000,
    compareAtSubtotalBeforeDiscounts: 150000,
    referralDiscountAmount: 0,
    creditsUsed: 0,
    creditsApplicable: 0,
    subtotalAfterDiscounts: 150000,
    vatRatePercent: 7.5,
    vatAmount: 0,
    compareAtVatAmount: 0,
    totalAmount: 150000,
    compareAtTotalAmount: 150000,
    savingsAmount: 0,
    ...overrides,
  };
}

export function buildVehicleOption(overrides?: Partial<VehicleSearchOption>): VehicleSearchOption {
  return {
    id: "vehicle_1",
    make: "Toyota",
    model: "Prado",
    name: "Toyota Prado",
    color: "black",
    vehicleType: "SUV",
    serviceTier: "EXECUTIVE",
    imageUrl: null,
    rates: { day: 65000, night: 70000, fullDay: 110000, airportPickup: 40000 },
    estimatedSubtotal: 150000,
    estimatedTotalInclVat: 150000,
    ...overrides,
  };
}
