import {
  BookingReferralStatus,
  BookingStatus,
  BookingType,
  CarApprovalStatus,
  ChauffeurApprovalStatus,
  ExtensionEventType,
  FleetOwnerStatus,
  type Payment,
  PaymentAttemptStatus,
  PaymentStatus,
  type PayoutTransaction,
  PayoutTransactionStatus,
  ServiceTier,
  Status,
  VehicleType,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import type { BookingFinancials } from "../modules/booking/booking-calculation.interface";
import { BookingWithRelations, ExtensionWithBookingLeg, PaymentWithRelations } from "../types";

/**
 * Mock objects for testing purposes
 */

export function createUser(
  overrides: Partial<BookingWithRelations["user"]> = {},
): BookingWithRelations["user"] {
  return {
    id: "user-123",
    email: "john@example.com",
    emailVerified: false,
    name: "John Doe",
    username: "johndoe",
    image: null,
    phoneNumber: "1234567890",
    address: "123 User St",
    city: "Lagos",
    hasOnboarded: true,
    isOwnerDriver: false,
    fleetOwnerId: null,
    fleetOwnerStatus: null,
    chauffeurApprovalStatus: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    referralDiscountUsed: false,
    referralCode: "REF123",
    referredByUserId: null,
    referralAttributionSource: null,
    referralSignupAt: null,
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
    emailVerified: false,
    username: "chauffeur",
    image: null,
    phoneNumber: "0987654321",
    address: "123 Chauffeur St",
    city: "Lagos",
    hasOnboarded: true,
    isOwnerDriver: false,
    fleetOwnerId: null,
    fleetOwnerStatus: null,
    chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
    referralCode: "CHAUF123",
    referredByUserId: null,
    referralAttributionSource: null,
    referralSignupAt: null,
    referralDiscountUsed: false,
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
    emailVerified: false,
    username: "fleetowner",
    image: null,
    phoneNumber: "5555555555",
    address: "123 Fleet St",
    city: "Lagos",
    hasOnboarded: true,
    isOwnerDriver: false,
    fleetOwnerId: null,
    fleetOwnerStatus: FleetOwnerStatus.APPROVED,
    chauffeurApprovalStatus: null,
    referralCode: "OWNER123",
    referredByUserId: null,
    referralAttributionSource: null,
    referralSignupAt: null,
    referralDiscountUsed: false,
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
    fuelUpgradeRate: 5000,
    fullDayRate: 25000,
    airportPickupRate: 30000,
    vehicleType: VehicleType.SEDAN,
    serviceTier: ServiceTier.STANDARD,
    passengerCapacity: 4,
    status: Status.BOOKED,
    approvalStatus: CarApprovalStatus.APPROVED,
    approvalNotes: null,
    ownerId: "owner-123",
    pricingIncludesFuel: false,
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
    platformCommissionRateOnLeg: new Decimal(10),
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
    deletedAt: null,
    totalAmount: new Decimal(10000),
    paymentId: null,
    paymentIntent: null,
    netTotal: new Decimal(9000),
    platformCustomerServiceFeeRatePercent: new Decimal(5),
    platformCustomerServiceFeeAmount: new Decimal(450),
    subtotalBeforeVat: new Decimal(9450),
    vatRatePercent: new Decimal(20),
    vatAmount: new Decimal(1890),
    platformFleetOwnerCommissionRatePercent: new Decimal(10),
    platformFleetOwnerCommissionAmount: new Decimal(900),
    fleetOwnerPayoutAmountNet: new Decimal(8100),
    cancellationReason: null,
    overallPayoutStatus: null,
    securityDetailCost: null,
    fuelUpgradeCost: null,
    referralReferrerUserId: null,
    referralDiscountAmount: new Decimal(0),
    referralStatus: BookingReferralStatus.NONE,
    referralCreditsUsed: new Decimal(0),
    referralCreditsReserved: new Decimal(0),
    flightNumber: null,
    estimatedDuration: null,
    flightId: null,
    carId: "car-123",
    chauffeurId: "chauffeur-123",
    userId: "user-123",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    guestUser: null,
    chauffeur: null,
    user: null,
    car: null,
    legs: null,
    ...overrides,
  };
}

/**
 * Create a mock Extension for testing.
 * Includes nested bookingLeg with booking for ownership checks.
 */
export function createExtension(
  overrides: Partial<ExtensionWithBookingLeg> = {},
): ExtensionWithBookingLeg {
  return {
    id: "extension-123",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    totalAmount: new Decimal(5000),
    paymentStatus: PaymentStatus.UNPAID,
    paymentId: null,
    paymentIntent: null,
    status: "PENDING",
    bookingLegId: "leg-123",
    eventType: ExtensionEventType.HOURLY_ADDITION,
    extendedDurationHours: 2,
    extensionStartTime: new Date("2024-01-01T18:00:00Z"),
    extensionEndTime: new Date("2024-01-01T20:00:00Z"),
    fleetOwnerPayoutAmountNet: null,
    netTotal: null,
    overallPayoutStatus: null,
    platformCustomerServiceFeeAmount: null,
    platformCustomerServiceFeeRatePercent: null,
    platformFleetOwnerCommissionAmount: null,
    platformFleetOwnerCommissionRatePercent: null,
    subtotalBeforeVat: null,
    vatAmount: null,
    vatRatePercent: null,
    bookingLeg: { booking: { userId: "user-123", status: BookingStatus.CONFIRMED } },
    ...overrides,
  };
}

/**
 * Create a mock Payment for testing.
 * Includes nested booking/extension for ownership checks.
 */
export function createPayment(overrides: Partial<PaymentWithRelations> = {}): PaymentWithRelations {
  return {
    id: "payment-123",
    bookingId: "booking-123",
    extensionId: null,
    txRef: "tx-ref-123",
    flutterwaveTransactionId: "flw-tx-123",
    flutterwaveReference: null,
    amountExpected: new Decimal(10000),
    amountCharged: new Decimal(10000),
    currency: "NGN",
    feeChargedByProvider: null,
    status: PaymentAttemptStatus.SUCCESSFUL,
    paymentProviderStatus: null,
    paymentMethod: null,
    initiatedAt: new Date("2024-01-01T00:00:00Z"),
    confirmedAt: new Date("2024-01-01T00:00:00Z"),
    lastVerifiedAt: null,
    webhookPayload: null,
    verificationResponse: null,
    refundIdempotencyKey: null,
    booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: "user-123" },
    extension: null,
    ...overrides,
  };
}

/**
 * Create a raw Payment record for testing (without relations).
 * Use this for webhook tests that don't need nested relations.
 */
export function createPaymentRecord(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "payment-123",
    bookingId: null,
    extensionId: null,
    txRef: "tx-ref-123",
    flutterwaveTransactionId: null,
    flutterwaveReference: null,
    amountExpected: new Decimal(10000),
    amountCharged: null,
    currency: "NGN",
    feeChargedByProvider: null,
    status: PaymentAttemptStatus.PENDING,
    paymentProviderStatus: null,
    paymentMethod: null,
    initiatedAt: new Date("2024-01-01T00:00:00Z"),
    confirmedAt: null,
    lastVerifiedAt: null,
    webhookPayload: null,
    verificationResponse: null,
    refundIdempotencyKey: null,
    ...overrides,
  };
}

/**
 * Create a mock PayoutTransaction for testing.
 */
export function createPayoutTransaction(
  overrides: Partial<PayoutTransaction> = {},
): PayoutTransaction {
  return {
    id: "payout-123",
    fleetOwnerId: "fleet-owner-123",
    bookingId: null,
    extensionId: null,
    amountToPay: new Decimal(5000),
    amountPaid: null,
    currency: "NGN",
    status: PayoutTransactionStatus.PROCESSING,
    payoutProviderReference: null,
    payoutMethodDetails: null,
    initiatedAt: new Date("2024-01-01T00:00:00Z"),
    processedAt: null,
    completedAt: null,
    notes: null,
    ...overrides,
  };
}

/**
 * Create mock booking financials for testing.
 */
export function createBookingFinancials(
  overrides: Partial<BookingFinancials> = {},
): BookingFinancials {
  return {
    legPrices: [{ legDate: new Date("2025-02-01"), price: new Decimal(50000) }],
    numberOfLegs: 1,
    netTotal: new Decimal(50000),
    securityDetailCost: new Decimal(0),
    fuelUpgradeCost: new Decimal(0),
    netTotalWithAddons: new Decimal(50000),
    platformFeeBase: new Decimal(50000),
    platformCustomerServiceFeeRatePercent: new Decimal(5),
    platformCustomerServiceFeeAmount: new Decimal(2500),
    subtotalBeforeDiscounts: new Decimal(52500),
    referralDiscountAmount: new Decimal(0),
    creditsUsed: new Decimal(0),
    subtotalAfterDiscounts: new Decimal(52500),
    vatRatePercent: new Decimal(7.5),
    vatAmount: new Decimal(3937.5),
    totalAmount: new Decimal(56437.5),
    platformFleetOwnerCommissionRatePercent: new Decimal(15),
    platformFleetOwnerCommissionAmount: new Decimal(7500),
    fleetOwnerPayoutAmountNet: new Decimal(42500),
    ...overrides,
  };
}
