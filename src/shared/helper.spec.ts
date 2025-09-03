import { BookingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { createBooking, formatCurrency, getCustomerDetails, getUserDisplayName } from "./helper";

describe("Helper Functions", () => {
  describe("formatCurrency", () => {
    it("should format currency correctly", () => {
      const result = formatCurrency(10000);
      expect(result).toContain("₦");
      expect(result).toContain("10,000");
    });

    it("should handle zero amount", () => {
      const result = formatCurrency(0);
      expect(result).toContain("₦0");
    });

    it("should handle decimal amounts", () => {
      const result = formatCurrency(1500.5);
      expect(result).toEqual("₦1,500.50");
    });
  });

  describe("getUserDisplayName", () => {
    it("should return user name when available", () => {
      const mockBooking = {
        user: { name: "John Doe", username: "johndoe", email: "john@example.com" },
        guestUser: null,
        car: { owner: { name: "Fleet Owner" } },
        chauffeur: null,
      } as any;

      const result = getUserDisplayName(mockBooking, "user");
      expect(result).toBe("John Doe");
    });

    it("should fallback to username when name not available", () => {
      const mockBooking = {
        user: { name: null, username: "johndoe", email: "john@example.com" },
        guestUser: null,
        car: { owner: { name: "Fleet Owner" } },
        chauffeur: null,
      } as any;

      const result = getUserDisplayName(mockBooking, "user");
      expect(result).toBe("johndoe");
    });

    it("should return Customer when no user details available", () => {
      const mockBooking = {
        user: null,
        guestUser: null,
        car: { owner: { name: "Fleet Owner" } },
        chauffeur: null,
      } as any;

      const result = getUserDisplayName(mockBooking, "user");
      expect(result).toBe("Customer");
    });

    it("should return fleet owner name", () => {
      const mockBooking = {
        user: null,
        guestUser: null,
        car: { owner: { name: "Fleet Owner", email: "owner@example.com" } },
        chauffeur: null,
      } as any;

      const result = getUserDisplayName(mockBooking, "owner");
      expect(result).toBe("Fleet Owner");
    });

    it("should return chauffeur name", () => {
      const mockBooking = {
        user: null,
        guestUser: null,
        car: { owner: { name: "Fleet Owner" } },
        chauffeur: { name: "Jane Smith", email: "jane@example.com" },
      } as any;

      const result = getUserDisplayName(mockBooking, "chauffeur");
      expect(result).toBe("Jane Smith");
    });
  });

  describe("getCustomerDetails", () => {
    it("should extract user details correctly", () => {
      const mockBooking = {
        user: {
          email: "user@example.com",
          name: "John Doe",
          phoneNumber: "1234567890",
        },
        guestUser: null,
      } as any;

      const result = getCustomerDetails(mockBooking);

      expect(result).toEqual({
        email: "user@example.com",
        name: "John Doe",
        phone_number: "1234567890",
      });
    });

    it("should extract guest user details when no regular user", () => {
      const mockBooking = {
        user: null,
        guestUser: {
          email: "guest@example.com",
          name: "Guest User",
          phoneNumber: "0987654321",
        },
      } as any;

      const result = getCustomerDetails(mockBooking);

      expect(result).toEqual({
        email: "guest@example.com",
        name: "Guest User",
        phone_number: "0987654321",
      });
    });

    it("should return empty strings when no user data available", () => {
      const mockBooking = {
        user: null,
        guestUser: null,
      } as any;

      const result = getCustomerDetails(mockBooking);

      expect(result).toEqual({
        email: "",
        name: "",
        phone_number: "",
      });
    });

    it("should handle null user properties gracefully", () => {
      const mockBooking = {
        user: {
          email: "user@example.com",
          name: null,
          phoneNumber: null,
        },
        guestUser: null,
      } as any;

      const result = getCustomerDetails(mockBooking);

      expect(result).toEqual({
        email: "user@example.com",
        name: "",
        phone_number: "",
      });
    });
  });

  describe("createBooking", () => {
    it("should create a booking with default values", () => {
      const booking = createBooking();

      expect(booking).toMatchObject({
        id: "booking-123",
        bookingReference: "REF-123",
        status: BookingStatus.CONFIRMED,
        pickupLocation: "Airport",
        returnLocation: "Hotel",
      });

      expect(booking.user).toMatchObject({
        id: "user-123",
        email: "user@example.com",
        name: "John Doe",
        phoneNumber: "1234567890",
      });

      expect(booking.chauffeur).toMatchObject({
        id: "chauffeur-123",
        name: "Jane Smith",
        email: "chauffeur@example.com",
      });

      expect(booking.car).toMatchObject({
        id: "car-123",
        make: "BMW",
        model: "X5",
        year: 2023,
      });

      expect(booking.legs).toHaveLength(1);
      expect(booking.legs[0]).toMatchObject({
        id: "leg-123",
        bookingId: "booking-123",
      });
    });

    it("should allow overriding top-level properties", () => {
      const booking = createBooking({
        id: "custom-booking-456",
        pickupLocation: "Custom Location",
        status: BookingStatus.ACTIVE,
      });

      expect(booking.id).toBe("custom-booking-456");
      expect(booking.pickupLocation).toBe("Custom Location");
      expect(booking.status).toBe(BookingStatus.ACTIVE);

      // Should keep default values for non-overridden properties
      expect(booking.returnLocation).toBe("Hotel");
      expect(booking.user?.name).toBe("John Doe");
    });

    it("should allow overriding nested user properties", () => {
      const booking = createBooking({
        user: {
          name: "Custom User",
          email: "custom@example.com",
        } as any,
      });

      expect(booking.user).toMatchObject({
        id: "user-123", // Default preserved
        name: "Custom User", // Override applied
        email: "custom@example.com", // Override applied
        phoneNumber: "1234567890", // Default preserved
      });
    });

    it("should allow overriding nested car and owner properties", () => {
      const booking = createBooking({
        car: {
          make: "Mercedes",
          model: "S-Class",
          owner: {
            name: "Custom Fleet Owner",
          } as any,
        } as any,
      });

      expect(booking.car).toMatchObject({
        id: "car-123", // Default preserved
        make: "Mercedes", // Override applied
        model: "S-Class", // Override applied
        year: 2023, // Default preserved
      });

      expect(booking.car.owner).toMatchObject({
        id: "owner-123", // Default preserved
        name: "Custom Fleet Owner", // Override applied
        email: "owner@example.com", // Default preserved
      });
    });

    it("should create booking suitable for testing user display names", () => {
      const booking = createBooking();

      const customerName = getUserDisplayName(booking, "user");
      const ownerName = getUserDisplayName(booking, "owner");
      const chauffeurName = getUserDisplayName(booking, "chauffeur");

      expect(customerName).toBe("John Doe");
      expect(ownerName).toBe("Fleet Owner");
      expect(chauffeurName).toBe("Jane Smith");
    });

    it("should create booking suitable for testing customer details", () => {
      const booking = createBooking();

      const customerDetails = getCustomerDetails(booking);

      expect(customerDetails).toEqual({
        email: "user@example.com",
        name: "John Doe",
        phone_number: "1234567890",
      });
    });

    it("should handle guest user scenario", () => {
      const booking = createBooking({
        user: null,
        guestUser: {
          name: "Guest User",
          email: "guest@example.com",
          phoneNumber: "9999999999",
        },
      });

      const customerDetails = getCustomerDetails(booking);
      const displayName = getUserDisplayName(booking, "user");

      expect(customerDetails).toEqual({
        email: "guest@example.com",
        name: "Guest User",
        phone_number: "9999999999",
      });

      expect(displayName).toBe("Guest User");
    });
  });
});
