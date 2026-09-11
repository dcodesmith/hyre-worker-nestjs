import { describe, expect, it } from "vitest";
import { NotificationType } from "../notification.interface";
import {
  BOOKING_STATUS_TEMPLATE_KIND,
  type BookingStatusTemplateData,
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
} from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { BookingStatusMapper } from "./booking-status-mapper";

describe("BookingStatusMapper", () => {
  const mapper = new BookingStatusMapper();
  const templateData: BookingStatusTemplateData = {
    templateKind: BOOKING_STATUS_TEMPLATE_KIND,
    bookingReference: "TRP-8F2K9Q",
    id: "booking-1",
    customerName: "Alex Johnson",
    ownerName: "Fleet Lagos Ltd",
    chauffeurName: "Sam Driver",
    chauffeurPhoneNumber: "+2348000000000",
    carName: "Toyota Camry (2022)",
    pickupLocation: "Lagos Airport",
    returnLocation: "Victoria Island",
    startDate: "Tue, Apr 21, 2026 · 2:00 PM",
    endDate: "Thu, Apr 23, 2026 · 10:00 AM",
    totalAmount: "₦450,000.00",
    title: "been assigned to you",
    status: "assigned",
    cancellationReason: "",
    subject: "You have been assigned a booking",
    oldStatus: "confirmed",
    newStatus: "assigned",
    recipientType: CHAUFFEUR_RECIPIENT_TYPE,
    recipientName: "Ada Driver",
  };

  it("handles chauffeur assignment status updates", () => {
    expect(mapper.canHandle(NotificationType.CHAUFFEUR_ASSIGNED)).toBe(true);
    expect(
      mapper.getTemplateKey(NotificationType.CHAUFFEUR_ASSIGNED, CHAUFFEUR_RECIPIENT_TYPE),
    ).toBe(Template.BookingStatusUpdate);
  });

  it("uses the chauffeur recipient name for WhatsApp variable 1", () => {
    expect(mapper.mapVariables(templateData, CHAUFFEUR_RECIPIENT_TYPE)["1"]).toBe("Ada Driver");
    expect(
      mapper.mapVariables({ ...templateData, recipientName: undefined }, CHAUFFEUR_RECIPIENT_TYPE)[
        "1"
      ],
    ).toBe("chauffeur");
  });

  it("uses the customer name for client recipients", () => {
    expect(mapper.mapVariables(templateData, CLIENT_RECIPIENT_TYPE)["1"]).toBe("Alex Johnson");
  });
});
