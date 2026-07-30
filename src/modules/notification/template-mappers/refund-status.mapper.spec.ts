import { describe, expect, it } from "vitest";
import { CLIENT_RECIPIENT_TYPE, OPERATIONS_RECIPIENT_TYPE } from "../notification.const";
import { NotificationType } from "../notification.interface";
import { REFUND_STATUS_TEMPLATE_KIND } from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { RefundStatusMapper } from "./refund-status.mapper";

describe("RefundStatusMapper", () => {
  const mapper = new RefundStatusMapper();

  it("maps successful customer refunds to the WhatsApp template", () => {
    expect(
      mapper.getTemplateKey(NotificationType.REFUND_STATUS_CHANGED, CLIENT_RECIPIENT_TYPE),
    ).toBe(Template.RefundSucceeded);
    expect(
      mapper.mapVariables({
        templateKind: REFUND_STATUS_TEMPLATE_KIND,
        subject: "Refund completed",
        status: "REFUNDED",
        recipientName: "Customer",
        amount: "₦15,000.00",
        bookingReference: "BR-123",
        paymentId: "payment-123",
        refundId: "refund-123",
      }),
    ).toEqual({
      "1": "Customer",
      "2": "₦15,000.00",
      "3": "BR-123",
    });
  });

  it("does not select a WhatsApp template for operations", () => {
    expect(
      mapper.getTemplateKey(NotificationType.REFUND_STATUS_CHANGED, OPERATIONS_RECIPIENT_TYPE),
    ).toBeNull();
  });
});
