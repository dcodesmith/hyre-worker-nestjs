import { describe, expect, it } from "vitest";
import { buildState, buildVehicleOption } from "./langgraph.factory";
import { buildOutboxItems } from "./langgraph-outbox.builder";

describe("langgraph-outbox.builder", () => {
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
    expect(outbox[1].templateVariables?.["1"]).toBe("Lexus GX");
    expect(outbox[1].templateVariables?.["2"]).toContain("incl. VAT");
    expect(outbox[2].templateVariables?.["1"]).toBe("Toyota Prado");
    expect(outbox[2].templateVariables?.["2"]).toContain("incl. VAT");
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

  it("builds checkout link as template in awaiting_payment stage", () => {
    const outbox = buildOutboxItems(
      buildState({
        stage: "awaiting_payment",
        selectedOption: buildVehicleOption({ make: "KIA", model: "Sportage LX" }),
        paymentLink: "https://checkout-v2.dev-flutterwave.com/v3/hosted/pay/c60612d08d53343872af",
      }),
      {
        text: "Booking created. I have sent your secure checkout link below.",
      },
    );

    expect(outbox).toHaveLength(1);
    expect(outbox[0].mode).toBe("TEMPLATE");
    expect(outbox[0].templateVariables).toEqual({
      "1": "Booking created. I have sent your secure checkout link below.",
      "2": "c60612d08d53343872af",
    });
  });

  it("falls back to free-form link when checkout token extraction fails", () => {
    const outbox = buildOutboxItems(
      buildState({
        stage: "awaiting_payment",
        paymentLink: "invalid-url",
      }),
      {
        text: "Booking created. I have sent your secure checkout link below.",
      },
    );

    expect(outbox).toHaveLength(1);
    expect(outbox[0].mode).toBe("FREE_FORM");
    expect(outbox[0].textBody).toContain("invalid-url");
  });
});
