import { describe, expect, it } from "vitest";
import {
  BOOKING_REMINDER_TEMPLATE_KIND,
  type BookingReminderTemplateData,
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
} from "../template-data.interface";
import { BookingReminderStartMapper } from "./booking-reminder-start-mapper";

describe("BookingReminderStartMapper", () => {
  const mapper = new BookingReminderStartMapper();

  describe("mapVariables", () => {
    const mockTemplateData: BookingReminderTemplateData = {
      templateKind: BOOKING_REMINDER_TEMPLATE_KIND,
      bookingLegId: "leg-123",
      bookingId: "booking-123",
      bookingReference: "TRP-8F2K9Q",
      legDate: "2024-01-15",
      chauffeurName: "John Driver",
      carName: "Toyota Camry (2022)",
      legStartTime: "10:00 AM",
      legEndTime: "6:00 PM",
      pickupLocation: "Lagos Airport",
      returnLocation: "Victoria Island",
      customerName: "Jane Customer",
      recipientType: CLIENT_RECIPIENT_TYPE,
      subject: "Booking Reminder",
    };

    it("should map chauffeur variables correctly", () => {
      const variables = mapper.mapVariables(mockTemplateData, CHAUFFEUR_RECIPIENT_TYPE);

      expect(variables).toEqual({
        "1": "John Driver",
        "2": "Toyota Camry (2022)",
        "3": "10:00 AM",
        "4": "6:00 PM",
        "5": "Lagos Airport",
        "6": "Victoria Island",
        "7": "Jane Customer",
      });
    });

    it("should map client variables correctly", () => {
      const variables = mapper.mapVariables(mockTemplateData, CLIENT_RECIPIENT_TYPE);

      expect(variables).toEqual({
        "1": "Jane Customer",
        "2": "Toyota Camry (2022)",
        "3": "10:00 AM",
        "4": "6:00 PM",
        "5": "Lagos Airport",
        "6": "Victoria Island",
        "7": "John Driver",
      });
    });
  });
});
