import {
  BookingStatus,
  BookingType,
  CarApprovalStatus,
  ChauffeurApprovalStatus,
  FleetOwnerStatus,
  PaymentStatus,
  Prisma,
  Status,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { format } from "date-fns";
import {
  BookingLegWithRelations,
  BookingWithRelations,
  GuestUserDetails,
  NormalisedBookingDetails,
  NormalisedBookingLegDetails,
} from "../types";

// Helper to generate a user-friendly name or email
export function getUserDisplayName(
  booking: Omit<BookingWithRelations, "legs">,
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

export function formatDate(date: string | Date) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: true,
  });

  function replaceWithOrdinalSuffix(day: string) {
    const num = Number.parseInt(day);
    const suffix = ["th", "st", "nd", "rd"][
      num % 10 > 3 || (num % 100) - (num % 10) === 10 ? 0 : num % 10
    ];
    return `${num}${suffix}`;
  }

  return formatter
    .format(new Date(date))
    .replace(/,/g, " @")
    .replace(/(\d+)(?=\s)/, replaceWithOrdinalSuffix);
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
  const carName = `${booking.car.make} ${booking.car.model} (${booking.car.year})`;
  const { pickupLocation, returnLocation, id, bookingReference } = booking;

  let title: string;
  let status: string;

  if (booking.status === BookingStatus.CONFIRMED) {
    title = "started";
    status = "active";
  } else if (booking.status === BookingStatus.ACTIVE) {
    title = "ended";
    status = "completed";
  } else {
    title = `status is ${booking.status.toLowerCase()}`;
    status = booking.status.toLowerCase();
  }

  return {
    bookingReference,
    id,
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
    startDate: formatDate(booking.startDate),
    endDate: formatDate(booking.endDate),
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

  return {
    bookingId: booking.id,
    customerName,
    chauffeurName,
    legDate: format(bookingLeg.legDate, "PPPP"),
    legStartTime: format(bookingLeg.legStartTime, "p"),
    legEndTime: format(bookingLeg.legEndTime, "p"),
    chauffeurPhoneNumber: booking.chauffeur?.phoneNumber ?? "",
    pickupLocation: booking.pickupLocation,
    returnLocation: booking.returnLocation,
    carName,
  };
}

/**
 * Creates a mock booking object for testing purposes
 * Provides sensible defaults while allowing overrides for specific test scenarios
 */
export function createBooking(overrides: Partial<BookingWithRelations> = {}): BookingWithRelations {
  const defaultBooking: BookingWithRelations = {
    id: "booking-123",
    bookingReference: "REF-123",
    status: BookingStatus.CONFIRMED,
    paymentStatus: PaymentStatus.PAID,
    type: BookingType.DAY,
    startDate: new Date("2024-01-01T08:00:00Z"),
    endDate: new Date("2024-01-01T20:00:00Z"),
    pickupLocation: "Airport",
    returnLocation: "Hotel",
    specialRequests: null,
    cancelledAt: null,
    totalAmount: new Decimal(10000),
    paymentId: null,
    paymentIntent: null,
    netTotal: new Decimal(9000),
    platformCustomerServiceFeeRatePercent: new Decimal(5.0),
    platformCustomerServiceFeeAmount: new Decimal(450),
    subtotalBeforeVat: new Decimal(9450),
    vatRatePercent: new Decimal(20.0),
    vatAmount: new Decimal(1890),
    platformFleetOwnerCommissionRatePercent: new Decimal(10.0),
    platformFleetOwnerCommissionAmount: new Decimal(900),
    fleetOwnerPayoutAmountNet: new Decimal(8100),
    cancellationReason: null,
    overallPayoutStatus: null,
    carId: "car-123",
    chauffeurId: "chauffeur-123",
    userId: "user-123",
    guestUser: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    user: {
      id: "user-123",
      email: "user@example.com",
      name: "John Doe",
      username: "johndoe",
      phoneNumber: "1234567890",
      address: "123 User St",
      city: "Lagos",
      hasOnboarded: true,
      fleetOwnerId: null,
      fleetOwnerStatus: null,
      chauffeurApprovalStatus: null,
      bankDetailsId: null,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    },
    chauffeur: {
      id: "chauffeur-123",
      name: "Jane Smith",
      email: "chauffeur@example.com",
      phoneNumber: "0987654321",
      username: "chauffeur",
      address: "123 Chauffeur St",
      city: "Lagos",
      hasOnboarded: true,
      fleetOwnerId: null,
      fleetOwnerStatus: null,
      chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
      bankDetailsId: "bank-123",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    },
    car: {
      id: "car-123",
      make: "BMW",
      model: "X5",
      year: 2023,
      color: "Black",
      registrationNumber: "ABC123XY",
      dayRate: 15000,
      nightRate: 20000,
      hourlyRate: 2000,
      status: Status.BOOKED,
      approvalStatus: CarApprovalStatus.APPROVED,
      approvalNotes: null,
      ownerId: "owner-123",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
      owner: {
        id: "owner-123",
        name: "Fleet Owner",
        email: "owner@example.com",
        username: "fleetowner",
        phoneNumber: "5555555555",
        address: "123 Fleet St",
        city: "Lagos",
        hasOnboarded: true,
        fleetOwnerId: null,
        fleetOwnerStatus: FleetOwnerStatus.APPROVED,
        chauffeurApprovalStatus: null,
        bankDetailsId: "bank-123",
        createdAt: new Date("2024-01-01T00:00:00Z"),
        updatedAt: new Date("2024-01-01T00:00:00Z"),
      },
    },
    legs: [
      {
        id: "leg-123",
        bookingId: "booking-123",
        legDate: new Date("2024-01-01"),
        legStartTime: new Date("2024-01-01T08:00:00Z"),
        legEndTime: new Date("2024-01-01T18:00:00Z"),
        itemsNetValueForLeg: new Decimal(8000),
        platformCommissionRateOnLeg: new Decimal(10.0),
        platformCommissionAmountOnLeg: new Decimal(800),
        fleetOwnerEarningForLeg: new Decimal(7200),
        totalDailyPrice: new Decimal(9500),
        notes: null,
        createdAt: new Date("2024-01-01T00:00:00Z"),
        updatedAt: new Date("2024-01-01T00:00:00Z"),
        extensions: [],
      },
    ],
  };

  return {
    ...defaultBooking,
    ...overrides,
    // Deep merge for nested objects, but respect null overrides
    user: Object.hasOwn(overrides, "user")
      ? overrides.user
        ? { ...defaultBooking.user, ...overrides.user }
        : overrides.user
      : defaultBooking.user,
    chauffeur: Object.hasOwn(overrides, "chauffeur")
      ? overrides.chauffeur
        ? { ...defaultBooking.chauffeur, ...overrides.chauffeur }
        : overrides.chauffeur
      : defaultBooking.chauffeur,
    car: overrides.car
      ? {
          ...defaultBooking.car,
          ...overrides.car,
          owner: overrides.car?.owner
            ? { ...defaultBooking.car.owner, ...overrides.car.owner }
            : defaultBooking.car.owner,
        }
      : defaultBooking.car,
    legs: overrides.legs || defaultBooking.legs,
  } as BookingWithRelations;
}
