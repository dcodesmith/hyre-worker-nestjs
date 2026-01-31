import { BookingStatus, Prisma } from "@prisma/client";
import { format } from "date-fns";
import {
  BookingLegWithRelations,
  BookingWithRelations,
  GuestUserDetails,
  NormalisedBookingDetails,
  NormalisedBookingLegDetails,
} from "../types";

/**
 * Masks an email address for safe logging (PII protection).
 * Example: "user@example.com" -> "u***@example.com"
 * Example: "ab@test.org" -> "a***@test.org"
 */
export function maskEmail(email: string): string {
  const [localPart, domain] = email.split("@");
  if (!domain) return "***";
  const maskedLocal = localPart.length > 0 ? `${localPart[0]}***` : "***";
  return `${maskedLocal}@${domain}`;
}

// Helper to generate a user-friendly name or email
export function getUserDisplayName(
  booking: Partial<Omit<BookingWithRelations, "legs">>,
  target: "user" | "owner" | "chauffeur" = "user",
): string {
  if (target === "user") {
    const guestDetails =
      booking.guestUser && typeof booking.guestUser === "object" && booking.guestUser !== null
        ? (booking.guestUser as GuestUserDetails)
        : null;

    return (
      booking.user?.name ||
      booking.user?.username ||
      booking.user?.email ||
      guestDetails?.name ||
      guestDetails?.email ||
      "Customer"
    );
  }

  if (target === "owner") {
    return (
      booking.car.owner?.name ||
      booking.car.owner?.username ||
      booking.car.owner?.email ||
      "Fleet Owner"
    );
  }

  if (target === "chauffeur" && booking.chauffeur) {
    return booking.chauffeur.name || booking.chauffeur.email || "Chauffeur";
  }

  return "User";
}

function replaceWithOrdinalSuffix(day: string) {
  const num = Number.parseInt(day);
  const suffix = ["th", "st", "nd", "rd"][
    num % 10 > 3 || (num % 100) - (num % 10) === 10 ? 0 : num % 10
  ];
  return `${num}${suffix}`;
}

export function formatDate(date: string | Date) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: true,
  });

  return formatter
    .format(new Date(date))
    .replaceAll(",", " @")
    .replaceAll(/(\d{1,2})(?=\s)/g, replaceWithOrdinalSuffix);
}

export const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(amount);
};

export function getCustomerDetails(
  booking: Prisma.BookingGetPayload<{
    include: { user: true; guestUser: true };
  }>,
): { email: string; name: string; phone_number: string } {
  let email = "";
  let name = "";
  let phone_number = "";

  if (booking.user) {
    email = booking.user.email;
    name = booking.user.name ?? "";
    phone_number = booking.user.phoneNumber ?? "";
  } else if (
    booking.guestUser &&
    typeof booking.guestUser === "object" &&
    booking.guestUser !== null
  ) {
    const guestDetails = booking.guestUser as GuestUserDetails;

    email = guestDetails.email ?? "";
    name = guestDetails.name ?? "";
    phone_number = guestDetails.phoneNumber ?? "";
  }

  return { email, name, phone_number };
}

export function normaliseBookingDetails(booking: BookingWithRelations): NormalisedBookingDetails {
  const customerName = getUserDisplayName(booking, "user");
  const ownerName = getUserDisplayName(booking, "owner");
  const chauffeurName = getUserDisplayName(booking, "chauffeur");
  const customerDetails = getCustomerDetails(booking);
  const carName = `${booking.car.make} ${booking.car.model} (${booking.car.year})`;
  const { pickupLocation, returnLocation, id, bookingReference } = booking;

  let title: string;
  let status: string;

  if (booking.status === BookingStatus.ACTIVE) {
    title = "started";
    status = "active";
  } else if (booking.status === BookingStatus.COMPLETED) {
    title = "ended";
    status = "completed";
  } else {
    title = `status is ${booking.status.toLowerCase()}`;
    status = booking.status.toLowerCase();
  }

  return {
    bookingReference,
    id,
    customerPhone: customerDetails.phone_number || undefined,
    customerEmail: customerDetails.email || undefined,
    ownerName,
    customerName,
    chauffeurName,
    chauffeurPhoneNumber: booking.chauffeur?.phoneNumber ?? "",
    carName,
    title,
    status,
    cancellationReason: booking.cancellationReason ?? "No reason provided",
    pickupLocation,
    returnLocation,
    startDate: format(booking.startDate, "PPPp"),
    endDate: format(booking.endDate, "PPPp"),
    totalAmount: formatCurrency(Number(booking.totalAmount.toFixed(2))),
  };
}

export function normaliseBookingLegDetails(
  bookingLeg: BookingLegWithRelations,
): NormalisedBookingLegDetails {
  const { booking } = bookingLeg;
  const customerName = getUserDisplayName(booking, "user");
  const chauffeurName = getUserDisplayName(booking, "chauffeur");
  const carName = `${booking.car.make} ${booking.car.model} (${booking.car.year})`;
  const customerDetails = getCustomerDetails(booking);

  return {
    bookingLegId: bookingLeg.id,
    bookingId: booking.id,
    customerName,
    customerPhone: customerDetails.phone_number || undefined,
    customerEmail: customerDetails.email || undefined,
    chauffeurName,
    legDate: format(bookingLeg.legDate, "PPPP"),
    legStartTime: format(bookingLeg.legStartTime, "PPPp"),
    legEndTime: format(bookingLeg.legEndTime, "PPPp"),
    chauffeurPhone: booking.chauffeur?.phoneNumber,
    chauffeurEmail: booking.chauffeur?.email,
    pickupLocation: booking.pickupLocation,
    returnLocation: booking.returnLocation,
    carName,
  };
}
