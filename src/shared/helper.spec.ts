import { BookingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  formatCurrency,
  generateBookingReference,
  getCustomerDetails,
  getUserDisplayName,
  maskEmail,
} from "./helper";
import {
  createBooking,
  createBookingLeg,
  createCar,
  createChauffeur,
  createOwner,
  createUser,
} from "./helper.fixtures";

describe("Helper Functions", () => {
  describe("maskEmail", () => {
    it("should mask email with single character local part", () => {
      expect(maskEmail("a@example.com")).toBe("a***@example.com");
    });

    it("should mask email with multi-character local part", () => {
      expect(maskEmail("user@example.com")).toBe("u***@example.com");
    });

    it("should mask email with long local part", () => {
      expect(maskEmail("verylongemail@test.org")).toBe("v***@test.org");
    });

    it("should preserve domain", () => {
      expect(maskEmail("john@subdomain.example.co.uk")).toBe("j***@subdomain.example.co.uk");
    });

    it("should return *** for invalid email without @", () => {
      expect(maskEmail("invalidemail")).toBe("***");
    });

    it("should handle empty local part", () => {
      expect(maskEmail("@example.com")).toBe("***@example.com");
    });
  });

  describe("formatCurrency", () => {
    it("should handle zero amount", () => {
      expect(formatCurrency(0)).toContain("₦0");
    });

    it("should handle decimal amounts", () => {
      expect(formatCurrency(1500.5)).toEqual("₦1,500.50");
    });
  });

  describe("getUserDisplayName", () => {
    it("should return user name when available", () => {
      const booking = createBooking({ user: createUser() });
      const result = getUserDisplayName(booking, "user");

      expect(result).toBe("John Doe");
    });

    it("should fallback to username when name not available", () => {
      const booking = createBooking({ user: createUser({ name: null, username: "johndoe" }) });
      const result = getUserDisplayName(booking, "user");

      expect(result).toBe("johndoe");
    });

    it("should return Customer when no user details available", () => {
      const user = createUser({ name: null, username: null, email: null });
      const booking = createBooking({ user });
      const result = getUserDisplayName(booking, "user");

      expect(result).toBe("Customer");
    });

    it("should return guest user name when user is null and guestUser exists", () => {
      const booking = createBooking({
        user: null,
        guestUser: {
          name: "Guest User",
          email: "guest@example.com",
          phoneNumber: "9999999999",
        },
      });
      const result = getUserDisplayName(booking, "user");

      expect(result).toBe("Guest User");
    });

    it("should return fleet owner name", () => {
      const booking = createBooking({ car: createCar({ owner: createOwner() }) });
      const result = getUserDisplayName(booking, "owner");

      expect(result).toBe("Fleet Owner");
    });

    it("should return chauffeur name", () => {
      const chauffeur = createChauffeur({ name: "Jane Smith", email: "jane@example.com" });
      const booking = createBooking({ chauffeur });
      const result = getUserDisplayName(booking, "chauffeur");

      expect(result).toBe("Jane Smith");
    });
  });

  describe("getCustomerDetails", () => {
    it("should extract user details correctly", () => {
      const user = createUser({
        email: "damola@example.com",
        name: "Damola",
        phoneNumber: "1234567890",
      });
      const booking = createBooking({ user });
      const result = getCustomerDetails(booking);

      expect(result).toEqual({
        email: "damola@example.com",
        name: "Damola",
        phone_number: "1234567890",
      });
    });

    it("should extract guest user details when no regular user", () => {
      const booking = createBooking({
        user: null,
        guestUser: {
          name: "Guest User",
          email: "guest@example.com",
          phoneNumber: "9999999999",
        },
      });
      const result = getCustomerDetails(booking);

      expect(result).toEqual({
        email: "guest@example.com",
        name: "Guest User",
        phone_number: "9999999999",
      });
    });

    it("should return empty strings when no user data available", () => {
      const booking = createBooking({ user: null, guestUser: null });
      const result = getCustomerDetails(booking);

      expect(result).toEqual({
        email: "",
        name: "",
        phone_number: "",
      });
    });

    it("should handle null user properties gracefully", () => {
      const booking = createBooking({
        user: createUser({ email: "john@example.com", name: null, phoneNumber: null }),
        guestUser: null,
      });

      const result = getCustomerDetails(booking);

      expect(result).toEqual({
        email: "john@example.com",
        name: "",
        phone_number: "",
      });
    });
  });

  describe("createBooking", () => {
    it("should create a booking with default values", () => {
      const booking = createBooking({
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser(),
        legs: [createBookingLeg()],
      });

      expect(booking).toMatchObject({
        id: "booking-123",
        bookingReference: "REF-123",
        status: BookingStatus.CONFIRMED,
        pickupLocation: "Airport",
        returnLocation: "Hotel",
      });

      expect(booking.user).toMatchObject({
        id: "user-123",
        email: "john@example.com",
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
        user: createUser(),
      });

      expect(booking.id).toBe("custom-booking-456");
      expect(booking.pickupLocation).toBe("Custom Location");
      expect(booking.status).toBe(BookingStatus.ACTIVE);

      expect(booking.returnLocation).toBe("Hotel");
      expect(booking.user?.name).toBe("John Doe");
    });

    it("should allow overriding nested user properties", () => {
      const booking = createBooking({
        user: createUser({ name: "Custom User", email: "custom@example.com" }),
      });

      expect(booking.user).toMatchObject({
        id: "user-123",
        name: "Custom User",
        email: "custom@example.com",
        phoneNumber: "1234567890",
      });
    });

    it("should allow overriding nested car and owner properties", () => {
      const booking = createBooking({
        car: createCar({
          make: "Mercedes",
          model: "S-Class",
          owner: createOwner({ name: "Custom Fleet Owner" }),
        }),
      });

      expect(booking.car).toMatchObject({
        id: "car-123",
        make: "Mercedes",
        model: "S-Class",
        year: 2023,
      });

      expect(booking.car.owner).toMatchObject({
        id: "owner-123",
        name: "Custom Fleet Owner",
        email: "owner@example.com",
      });
    });

    it("should create booking with guest user and null user when guestUser provided", () => {
      const guestUser = {
        name: "Guest User",
        email: "guest@example.com",
        phoneNumber: "9999999999",
      };
      const booking = createBooking({ user: null, guestUser });

      expect(booking.user).toBeNull();
      expect(booking.guestUser).toEqual(guestUser);
    });

    it("should set guestUser to null when user is provided", () => {
      const user = createUser({ name: "Regular User" });
      const booking = createBooking({ user });

      expect(booking.user).toMatchObject({ name: "Regular User" });
      expect(booking.guestUser).toBeNull();
    });
  });

  describe("generateBookingReference", () => {
    it("should generate a reference matching the expected format", () => {
      const ref = generateBookingReference();
      expect(ref).toMatch(/^BK-[A-Z0-9]{8}$/);
    });

    it("should generate unique references", () => {
      const ref1 = generateBookingReference();
      const ref2 = generateBookingReference();
      const ref3 = generateBookingReference();

      expect(ref1).not.toBe(ref2);
      expect(ref2).not.toBe(ref3);
      expect(ref3).not.toBe(ref1);
    });

    it("should use only uppercase letters and numbers", () => {
      const ref = generateBookingReference();
      expect(ref.slice(3)).toMatch(/^[0-9A-Z]{8}$/);
    });
  });
});
