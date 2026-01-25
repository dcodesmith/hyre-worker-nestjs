import { describe, expect, it } from "vitest";
import { NotificationType } from "../notification.interface";
import { Template } from "../whatsapp.service";
import { BookingReminderStartMapper } from "./booking-reminder-start-mapper";

describe("BookingReminderStartMapper", () => {
  const mapper = new BookingReminderStartMapper();

  describe("canHandle", () => {
    it("should return true for BOOKING_REMINDER_START type", () => {
      expect(mapper.canHandle(NotificationType.BOOKING_REMINDER_START)).toBe(true);
    });

    it("should return false for BOOKING_REMINDER_END type", () => {
      expect(mapper.canHandle(NotificationType.BOOKING_REMINDER_END)).toBe(false);
    });

    it("should return false for BOOKING_CONFIRMED type", () => {
      expect(mapper.canHandle(NotificationType.BOOKING_CONFIRMED)).toBe(false);
    });

    it("should return false for FLEET_OWNER_NEW_BOOKING type", () => {
      expect(mapper.canHandle(NotificationType.FLEET_OWNER_NEW_BOOKING)).toBe(false);
    });
  });

  describe("getTemplateKey", () => {
    it("should return ChauffeurBookingLegStartReminder for chauffeur recipient", () => {
      expect(mapper.getTemplateKey(NotificationType.BOOKING_REMINDER_START, "chauffeur")).toBe(
        Template.ChauffeurBookingLegStartReminder,
      );
    });

    it("should return ClientBookingLegStartReminder for client recipient", () => {
      expect(mapper.getTemplateKey(NotificationType.BOOKING_REMINDER_START, "client")).toBe(
        Template.ClientBookingLegStartReminder,
      );
    });

    it("should return null for fleetOwner recipient", () => {
      expect(mapper.getTemplateKey(NotificationType.BOOKING_REMINDER_START, "fleetOwner")).toBeNull();
    });

    it("should return null for unknown recipient types", () => {
      expect(mapper.getTemplateKey(NotificationType.BOOKING_REMINDER_START, "unknown")).toBeNull();
    });

    it("should return null for other notification types", () => {
      expect(mapper.getTemplateKey(NotificationType.BOOKING_CONFIRMED, "client")).toBeNull();
    });
  });

  describe("mapVariables", () => {
    const mockTemplateData = {
      chauffeurName: "John Driver",
      carName: "Toyota Camry (2022)",
      legStartTime: "10:00 AM",
      legEndTime: "6:00 PM",
      pickupLocation: "Lagos Airport",
      returnLocation: "Victoria Island",
      customerName: "Jane Customer",
      subject: "Booking Reminder",
    };

    it("should map chauffeur variables correctly", () => {
      const variables = mapper.mapVariables(mockTemplateData, "chauffeur");

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
      const variables = mapper.mapVariables(mockTemplateData, "client");

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

    it("should return empty string for missing fields", () => {
      const incompleteData = {
        customerName: "Jane Customer",
        carName: "BMW X5",
      };

      const variables = mapper.mapVariables(incompleteData, "client");

      expect(variables["1"]).toBe("Jane Customer");
      expect(variables["2"]).toBe("BMW X5");
      expect(variables["3"]).toBe("");
      expect(variables["4"]).toBe("");
      expect(variables["5"]).toBe("");
      expect(variables["6"]).toBe("");
      expect(variables["7"]).toBe("");
    });
  });
});
