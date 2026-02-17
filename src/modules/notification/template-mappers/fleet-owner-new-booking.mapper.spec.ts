import { describe, expect, it } from "vitest";
import { NotificationType } from "../notification.interface";
import type { FleetOwnerNewBookingTemplateData } from "../template-data.interface";
import { FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND } from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { FleetOwnerNewBookingMapper } from "./fleet-owner-new-booking.mapper";

describe("FleetOwnerNewBookingMapper", () => {
  const mapper = new FleetOwnerNewBookingMapper();

  describe("canHandle", () => {
    it("should return true for FLEET_OWNER_NEW_BOOKING type", () => {
      expect(mapper.canHandle(NotificationType.FLEET_OWNER_NEW_BOOKING)).toBe(true);
    });

    it("should return false for BOOKING_CONFIRMED type", () => {
      expect(mapper.canHandle(NotificationType.BOOKING_CONFIRMED)).toBe(false);
    });

    it("should return false for BOOKING_STATUS_CHANGE type", () => {
      expect(mapper.canHandle(NotificationType.BOOKING_STATUS_CHANGE)).toBe(false);
    });

    it("should return false for BOOKING_REMINDER_START type", () => {
      expect(mapper.canHandle(NotificationType.BOOKING_REMINDER_START)).toBe(false);
    });

    it("should return false for BOOKING_REMINDER_END type", () => {
      expect(mapper.canHandle(NotificationType.BOOKING_REMINDER_END)).toBe(false);
    });
  });

  describe("getTemplateKey", () => {
    it("should return FleetOwnerBookingNotification template for FLEET_OWNER_NEW_BOOKING type", () => {
      expect(mapper.getTemplateKey(NotificationType.FLEET_OWNER_NEW_BOOKING, "fleetOwner")).toBe(
        Template.FleetOwnerBookingNotification,
      );
    });

    it("should return null for other notification types", () => {
      expect(mapper.getTemplateKey(NotificationType.BOOKING_CONFIRMED, "client")).toBeNull();
    });
  });

  describe("mapVariables", () => {
    const mockTemplateData: FleetOwnerNewBookingTemplateData = {
      templateKind: FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND,
      bookingReference: "BK-12345678",
      ownerName: "Fleet Owner Name",
      chauffeurName: "Driver Name",
      chauffeurPhoneNumber: "+2348012345678",
      carName: "Toyota Camry (2022)",
      customerName: "John Doe",
      startDate: "January 15, 2024 at 10:00 AM",
      endDate: "January 16, 2024 at 6:00 PM",
      pickupLocation: "Lagos Airport",
      returnLocation: "Victoria Island",
      totalAmount: "₦50,000",
      title: "Airport Transfer",
      status: "CONFIRMED",
      cancellationReason: "",
      id: "booking-123",
      subject: "New Booking Alert",
    };

    it("should map all 9 variables correctly", () => {
      const variables = mapper.mapVariables(mockTemplateData, "fleetOwner");

      expect(variables).toEqual({
        "1": "Fleet Owner Name",
        "2": "Toyota Camry (2022)",
        "3": "John Doe",
        "4": "January 15, 2024 at 10:00 AM",
        "5": "January 16, 2024 at 6:00 PM",
        "6": "Lagos Airport",
        "7": "Victoria Island",
        "8": "₦50,000",
        "9": "booking-123",
      });
    });

    it("should return empty string for missing fields", () => {
      const incompleteData = {
        ...mockTemplateData,
        ownerName: "Fleet Owner",
        carName: "BMW X5",
        customerName: "",
        startDate: "",
        endDate: "",
        pickupLocation: "",
        returnLocation: "",
        totalAmount: "",
        id: "",
      };

      const variables = mapper.mapVariables(incompleteData, "fleetOwner");

      expect(variables["1"]).toBe("Fleet Owner");
      expect(variables["2"]).toBe("BMW X5");
      expect(variables["3"]).toBe("");
      expect(variables["4"]).toBe("");
      expect(variables["5"]).toBe("");
      expect(variables["6"]).toBe("");
      expect(variables["7"]).toBe("");
      expect(variables["8"]).toBe("");
      expect(variables["9"]).toBe("");
    });
  });
});
