import { describe, expect, it } from "vitest";
import { FLEET_OWNER_RECIPIENT_TYPE, OPERATIONS_RECIPIENT_TYPE } from "../notification.const";
import { NotificationType } from "../notification.interface";
import { PAYOUT_STATUS_TEMPLATE_KIND } from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { PayoutStatusMapper } from "./payout-status.mapper";

describe("PayoutStatusMapper", () => {
  const mapper = new PayoutStatusMapper();

  it("maps successful fleet-owner payouts to the WhatsApp template", () => {
    expect(
      mapper.getTemplateKey(NotificationType.PAYOUT_STATUS_CHANGED, FLEET_OWNER_RECIPIENT_TYPE),
    ).toBe(Template.PayoutSucceeded);
    expect(
      mapper.mapVariables({
        templateKind: PAYOUT_STATUS_TEMPLATE_KIND,
        subject: "Payout sent",
        status: "PAID_OUT",
        recipientName: "Fleet Owner",
        amount: "₦15,000.00",
        bookingReference: "BR-123",
        payoutTransactionId: "payout-123",
      }),
    ).toEqual({
      "1": "Fleet Owner",
      "2": "₦15,000.00",
      "3": "BR-123",
    });
  });

  it("does not select a WhatsApp template for operations", () => {
    expect(
      mapper.getTemplateKey(NotificationType.PAYOUT_STATUS_CHANGED, OPERATIONS_RECIPIENT_TYPE),
    ).toBeNull();
  });
});
