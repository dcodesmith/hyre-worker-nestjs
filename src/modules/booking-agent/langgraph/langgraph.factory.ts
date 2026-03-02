import type { BookingAgentState, VehicleSearchOption } from "./langgraph.interface";

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
    nextNode: null,
    error: null,
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
    estimatedTotalInclVat: 150000,
    ...overrides,
  };
}
