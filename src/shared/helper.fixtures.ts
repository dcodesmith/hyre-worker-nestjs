import {
  BookingStatus,
  BookingType,
  CarApprovalStatus,
  ChauffeurApprovalStatus,
  FleetOwnerStatus,
  PaymentStatus,
  Status,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { BookingWithRelations } from "../types";

/**
 * Mock objects for testing purposes
 */

export function createUser(
  overrides: Partial<BookingWithRelations["user"]> = {},
): BookingWithRelations["user"] {
  return {
    id: "user-123",
    email: "john@example.com",
    name: "John Doe",
    username: "johndoe",
    phoneNumber: "1234567890",
    address: "123 User St",
    city: "Lagos",
    hasOnboarded: true,
    fleetOwnerId: null,
    fleetOwnerStatus: null,
    chauffeurApprovalStatus: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

export function createChauffeur(
  overrides: Partial<BookingWithRelations["chauffeur"]> = {},
): BookingWithRelations["chauffeur"] {
  return {
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
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

export function createOwner(
  overrides: Partial<BookingWithRelations["car"]["owner"]> = {},
): BookingWithRelations["car"]["owner"] {
  return {
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
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

export function createCar(
  overrides: Partial<BookingWithRelations["car"]> = {},
): BookingWithRelations["car"] {
  const owner = createOwner(overrides.owner);

  return {
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
    ...overrides,
    owner,
  };
}

export function createBookingLeg(
  overrides: Partial<BookingWithRelations["legs"][number]> = {},
): BookingWithRelations["legs"][number] {
  return {
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
    ...overrides,
  };
}

export function createBooking(overrides: Partial<BookingWithRelations> = {}): BookingWithRelations {
  const { chauffeur, user, car, legs, ...restOverrides } = overrides;

  return {
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
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    guestUser: null,
    ...restOverrides,
    chauffeur: createChauffeur(chauffeur),
    user: createUser(user),
    car: createCar(car),
    legs: legs?.map(createBookingLeg) ?? [createBookingLeg()],
  };
}
