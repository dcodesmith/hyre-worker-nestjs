import { describe, expect, it } from "vitest";
import { buildOutboxItems } from "./booking-agent-outbox.builder";
import { BOOKING_AGENT_BUTTON_ID, BOOKING_CONFIRMATION_CONTENT_SID } from "./conversation.const";
import { buildState, buildVehicleOption } from "./conversation.factory";

describe("booking-agent-outbox.builder", () => {
  it("builds intro + template cards mapped by vehicleId", () => {
    const veh1 = buildVehicleOption({ id: "veh_1", make: "Toyota", model: "Prado" });
    const veh2 = buildVehicleOption({ id: "veh_2", make: "Lexus", model: "GX" });

    const outbox = buildOutboxItems(
      buildState({
        stage: "presenting_options",
        inboundMessage: "show me options",
        availableOptions: [veh1, veh2],
      }),
      {
        text: "Here are your options!",
        vehicleCards: [
          {
            vehicleId: "veh_2",
            imageUrl: "https://img/2.jpg",
            caption: "Card 2",
            buttonId: "select_vehicle:veh_2",
            buttonTitle: "Select",
          },
          {
            vehicleId: "veh_1",
            imageUrl: "https://img/1.jpg",
            caption: "Card 1",
            buttonId: "select_vehicle:veh_1",
            buttonTitle: "Select",
          },
        ],
      },
    );

    expect(outbox).toHaveLength(3);
    expect(outbox[0].mode).toBe("FREE_FORM");
    expect(outbox[1].mode).toBe("TEMPLATE");
    expect(outbox[1].templateVariables?.["1"]).toBe("Lexus GX · ₦150,000");
    expect(outbox[1].templateVariables?.["2"]).toBe("₦150,000");
    expect(outbox[2].templateVariables?.["1"]).toBe("Toyota Prado · ₦150,000");
    expect(outbox[2].templateVariables?.["2"]).toBe("₦150,000");
  });

  it("falls back to single free-form message when cards do not map to available options", () => {
    const outbox = buildOutboxItems(
      buildState({
        stage: "presenting_options",
        inboundMessage: "show me options",
        availableOptions: [buildVehicleOption({ id: "veh_1" })],
      }),
      {
        text: "Here are your options!",
        vehicleCards: [
          {
            vehicleId: "veh_missing",
            imageUrl: null,
            caption: "Missing",
            buttonId: "select_vehicle:veh_missing",
            buttonTitle: "Select",
          },
        ],
      },
    );

    expect(outbox).toHaveLength(1);
    expect(outbox[0].mode).toBe("FREE_FORM");
    expect(outbox[0].templateName).toBeUndefined();
  });

  it("uses the vehicle base price for template pricing", () => {
    const outbox = buildOutboxItems(
      buildState({
        stage: "presenting_options",
        inboundMessage: "show me options",
        availableOptions: [
          buildVehicleOption({
            id: "veh_1",
            make: "Toyota",
            model: "Corolla",
            rates: { day: 120000, night: 70000, fullDay: 110000, airportPickup: 40000 },
            estimatedSubtotal: 120000,
            estimatedTotalInclVat: 129000,
          }),
        ],
      }),
      {
        text: "Here are your options!",
        vehicleCards: [
          {
            vehicleId: "veh_1",
            imageUrl: "https://img/1.jpg",
            caption: "Fallback caption ₦222,000",
            priceLabel: "₦180,000",
            priceValue: 195000,
            buttonId: "select_vehicle:veh_1",
            buttonTitle: "Select",
          },
        ],
      },
    );

    expect(outbox).toHaveLength(2);
    expect(outbox[1].templateVariables?.["1"]).toBe("Toyota Corolla · ₦120,000");
    expect(outbox[1].templateVariables?.["2"]).toBe("₦120,000");
  });

  it("sends an image-less vehicle card as selectable text", () => {
    const outbox = buildOutboxItems(
      buildState({
        stage: "presenting_options",
        availableOptions: [buildVehicleOption({ id: "veh_1" })],
      }),
      {
        text: "Here are your options!",
        vehicleCards: [
          {
            vehicleId: "veh_1",
            imageUrl: null,
            caption: "Toyota Prado",
            buttonId: "select_vehicle:veh_1",
            buttonTitle: "Select",
          },
        ],
      },
    );

    expect(outbox[1]).toMatchObject({
      mode: "FREE_FORM",
      textBody: 'Toyota Prado\n\nReply "Option 1" to select this car.',
    });
  });

  it("sends one confirmation template with the quote body and static quick replies", () => {
    const outbox = buildOutboxItems(
      buildState({
        stage: "confirming",
        selectedOption: buildVehicleOption(),
      }),
      {
        text: "Booking summary\n\nReady to confirm this booking?",
        interactive: {
          type: "buttons",
          buttons: [{ id: BOOKING_AGENT_BUTTON_ID.CONFIRM, title: "Confirm Booking" }],
        },
      },
    );

    expect(outbox).toEqual([
      {
        conversationId: "conv_test",
        dedupeKey: "booking-agent:msg_1:confirmation",
        mode: "TEMPLATE",
        textBody: "Booking summary",
        templateName: BOOKING_CONFIRMATION_CONTENT_SID,
      },
    ]);
  });

  it.each([
    "https://checkout.flutterwave.com/v3/hosted/pay/c60612d08d53343872af",
    "https://checkout-v2.dev-flutterwave.com/v3/hosted/pay/2207c37f2a302c03118f",
    "invalid-url",
  ])("sends the complete checkout URL for %s", (paymentLink) => {
    const outbox = buildOutboxItems(
      buildState({
        stage: "awaiting_payment",
        selectedOption: buildVehicleOption({ make: "KIA", model: "Sportage LX" }),
        paymentLink,
      }),
      {
        text: "Booking created. I have sent your secure checkout link below.",
      },
    );

    expect(outbox).toEqual([
      {
        conversationId: "conv_test",
        dedupeKey: "booking-agent:msg_1:payment-link",
        mode: "FREE_FORM",
        textBody: `Booking created. I have sent your secure checkout link below.\n\n${paymentLink}`,
      },
    ]);
  });

  it("does not duplicate a checkout URL already present in the message", () => {
    const paymentLink =
      "https://checkout-v2.dev-flutterwave.com/v3/hosted/pay/2207c37f2a302c03118f";
    const outbox = buildOutboxItems(
      buildState({
        stage: "awaiting_payment",
        paymentLink,
      }),
      {
        text: `Complete payment:\n\n${paymentLink}`,
      },
    );

    expect(outbox[0].textBody).toBe(`Complete payment:\n\n${paymentLink}`);
  });

  it.each([
    {
      host: "checkout.flutterwave.com",
      contentSid: "HX45313efd782a11095cb73b2ee3d5306f",
      paymentId: "c60612d08d53343872af",
    },
    {
      host: "checkout-v2.dev-flutterwave.com",
      contentSid: "HXb0294ce1288f914fe65ad645245278e1",
      paymentId: "2207c37f2a302c03118f",
    },
  ])("sends a Pay Now template for $host", ({ host, contentSid, paymentId }) => {
    const outbox = buildOutboxItems(
      buildState({
        stage: "awaiting_payment",
        paymentLink: `https://${host}/v3/hosted/pay/${paymentId}`,
        holdExpiresAt: "2026-03-01T15:30:00.000Z",
      }),
      {
        text: "Booking created. I have sent your secure checkout link below.",
      },
    );

    expect(outbox).toEqual([
      {
        conversationId: "conv_test",
        dedupeKey: "booking-agent:msg_1:payment-link",
        mode: "TEMPLATE",
        templateName: contentSid,
        templateVariables: {
          "1": "1st Mar 2026 at 4:30 pm (Lagos time)",
          "2": paymentId,
        },
      },
    ]);
  });

  it.each([
    "invalid-url",
    "https://pay.example.com/v3/hosted/pay/c60612d08d53343872af",
    "http://checkout.flutterwave.com/v3/hosted/pay/c60612d08d53343872af",
    "https://checkout.flutterwave.com/v3/hosted/pay/c60612d08d53343872af?ref=1",
    "https://user:secret@checkout.flutterwave.com/v3/hosted/pay/c60612d08d53343872af",
  ])("keeps the complete checkout link for %s", (paymentLink) => {
    const outbox = buildOutboxItems(
      buildState({
        stage: "awaiting_payment",
        paymentLink,
        holdExpiresAt: "2026-03-01T15:30:00.000Z",
      }),
      {
        text: "Booking created. I have sent your secure checkout link below.",
      },
    );

    expect(outbox).toEqual([
      {
        conversationId: "conv_test",
        dedupeKey: "booking-agent:msg_1:payment-link",
        mode: "FREE_FORM",
        textBody: `Booking created. I have sent your secure checkout link below.\n\n${paymentLink}`,
      },
    ]);
  });

  it("keeps the complete checkout link when the reservation expiry is invalid", () => {
    const paymentLink = "https://checkout.flutterwave.com/v3/hosted/pay/c60612d08d53343872af";
    const outbox = buildOutboxItems(
      buildState({
        stage: "awaiting_payment",
        paymentLink,
        holdExpiresAt: "not-a-date",
      }),
      {
        text: `Complete payment:\n\n${paymentLink}`,
      },
    );

    expect(outbox).toEqual([
      {
        conversationId: "conv_test",
        dedupeKey: "booking-agent:msg_1:payment-link",
        mode: "FREE_FORM",
        textBody: `Complete payment:\n\n${paymentLink}`,
      },
    ]);
  });
});
