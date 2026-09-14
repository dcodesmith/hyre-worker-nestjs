-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "FlightStatus" AS ENUM ('SCHEDULED', 'DEPARTED', 'EN_ROUTE', 'LANDED', 'CANCELLED', 'DIVERTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FlightDataSource" AS ENUM ('FLIGHTAWARE', 'MANUAL', 'CACHED');

-- CreateEnum
CREATE TYPE "Status" AS ENUM ('AVAILABLE', 'BOOKED', 'HOLD', 'IN_SERVICE');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BookingCompletionSource" AS ENUM ('SCHEDULED', 'CHAUFFEUR_LINK', 'FLEET_OWNER', 'OPERATIONS');

-- CreateEnum
CREATE TYPE "BookingCreationIdempotencyState" AS ENUM ('PROCESSING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ExtensionCreationIdempotencyState" AS ENUM ('PROCESSING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_PROCESSING', 'REFUND_FAILED');

-- CreateEnum
CREATE TYPE "BookingType" AS ENUM ('DAY', 'NIGHT', 'FULL_DAY', 'AIRPORT_PICKUP');

-- CreateEnum
CREATE TYPE "BookingAcquisitionChannel" AS ENUM ('GLOBAL', 'PARTNER');

-- CreateEnum
CREATE TYPE "ExtensionEventType" AS ENUM ('HOURLY_ADDITION', 'NEW_DAY_ADDITION');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PENDING', 'SUCCESSFUL', 'FAILED', 'REFUNDED', 'REFUND_PROCESSING', 'REFUND_FAILED', 'PARTIALLY_REFUNDED', 'REFUND_ERROR');

-- CreateEnum
CREATE TYPE "PayoutTransactionStatus" AS ENUM ('PENDING_APPROVAL', 'PENDING_DISBURSEMENT', 'PROCESSING', 'PAID_OUT', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "FinancialReconciliationResourceType" AS ENUM ('REFUND', 'PAYOUT');

-- CreateEnum
CREATE TYPE "FinancialReconciliationOutcome" AS ENUM ('STARTED', 'RECONCILED', 'UNRESOLVED', 'FAILED');

-- CreateEnum
CREATE TYPE "CarApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProviderVerificationStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "FleetOwnerAccountType" AS ENUM ('INDIVIDUAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "AccountVerificationStatus" AS ENUM ('DRAFT', 'PROCESSING', 'SUCCEEDED', 'REVIEW_REQUIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "AccountVerificationStage" AS ENUM ('PAYOUT', 'DRIVING', 'SUBMISSION');

-- CreateEnum
CREATE TYPE "NameMatchStatus" AS ENUM ('MATCHED', 'REVIEW_REQUIRED', 'MISMATCHED');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('SEDAN', 'SUV', 'VAN', 'CROSSOVER');

-- CreateEnum
CREATE TYPE "ServiceTier" AS ENUM ('STANDARD', 'EXECUTIVE', 'LUXURY', 'ULTRA_LUXURY');

-- CreateEnum
CREATE TYPE "FleetOwnerStatus" AS ENUM ('PROCESSING', 'APPROVED', 'ON_HOLD', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ChauffeurApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ChauffeurVerificationStatus" AS ENUM ('INVITED', 'CONSENTED', 'PHONE_VERIFIED', 'IDENTITY_VERIFIED', 'APPROVED');

-- CreateEnum
CREATE TYPE "ChauffeurVerificationStage" AS ENUM ('IDENTITY', 'DRIVING');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('NIN', 'DRIVERS_LICENSE', 'MOT_CERTIFICATE', 'INSURANCE_CERTIFICATE', 'VEHICLE_IMAGES', 'CERTIFICATE_OF_INCORPORATION', 'LASDRI', 'LASRRA', 'DRIVER_BADGE');

-- CreateEnum
CREATE TYPE "PlatformFeeType" AS ENUM ('PLATFORM_SERVICE_FEE', 'FLEET_OWNER_COMMISSION');

-- CreateEnum
CREATE TYPE "AddonPricingUnit" AS ENUM ('PER_BOOKING', 'PER_LEG');

-- CreateEnum
CREATE TYPE "AddonFinancialTreatment" AS ENUM ('PLATFORM', 'FLEET_OWNER');

-- CreateEnum
CREATE TYPE "ReferralAttributionSource" AS ENUM ('LINK', 'MANUAL', 'IMPORT');

-- CreateEnum
CREATE TYPE "ReferralRewardStatus" AS ENUM ('PENDING', 'RELEASED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ReferralReleaseCondition" AS ENUM ('PAID', 'COMPLETED');

-- CreateEnum
CREATE TYPE "BookingReferralStatus" AS ENUM ('NONE', 'RESERVED', 'APPLIED', 'REWARDED', 'REVERSED');

-- CreateEnum
CREATE TYPE "BookingDraftStatus" AS ENUM ('NEW', 'COLLECTING', 'QUOTED', 'AWAITING_PAYMENT', 'CONFIRMED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WhatsAppConversationStatus" AS ENUM ('ACTIVE', 'HANDOFF', 'CLOSED');

-- CreateEnum
CREATE TYPE "WhatsAppLinkStatus" AS ENUM ('UNLINKED', 'PENDING_VERIFICATION', 'LINKED', 'REVOKED');

-- CreateEnum
CREATE TYPE "WhatsAppDeliveryMode" AS ENUM ('FREE_FORM', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "WhatsAppMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "WhatsAppMessageKind" AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'DOCUMENT', 'LOCATION', 'INTERACTIVE', 'SYSTEM', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WhatsAppMessageStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "WhatsAppOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('IOS', 'ANDROID');

-- CreateEnum
CREATE TYPE "NotificationInboxType" AS ENUM ('BOOKING_ASSIGNMENT', 'BOOKING_LIFECYCLE', 'BOOKING_REMINDER', 'CHAUFFEUR_ASSIGNED');

-- CreateEnum
CREATE TYPE "NotificationOutboxEventType" AS ENUM ('BOOKING_ASSIGNMENT', 'BOOKING_LIFECYCLE', 'BOOKING_REMINDER', 'CHAUFFEUR_ASSIGNED');

-- CreateEnum
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DISPATCHED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "DomainOutboxEventType" AS ENUM ('REFERRAL_COMPLETION', 'PAYOUT_PROCESSING');

-- CreateEnum
CREATE TYPE "DomainOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DISPATCHED', 'COMPLETED', 'FAILED', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "Car" (
    "id" UUID NOT NULL,
    "publicRef" VARCHAR(16) NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "color" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "chassisNumber" TEXT,
    "status" "Status" NOT NULL,
    "approvalStatus" "CarApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approvalNotes" TEXT,
    "submittedAt" TIMESTAMP(3),
    "hourlyRate" INTEGER,
    "dayRate" INTEGER,
    "nightRate" INTEGER,
    "fuelUpgradeRate" INTEGER,
    "fullDayRate" INTEGER,
    "airportPickupRate" INTEGER,
    "vehicleType" "VehicleType" NOT NULL DEFAULT 'SEDAN',
    "serviceTier" "ServiceTier" NOT NULL DEFAULT 'STANDARD',
    "passengerCapacity" INTEGER NOT NULL DEFAULT 4,
    "pricingIncludesFuel" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Car_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleVerification" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "chassisNumber" TEXT,
    "make" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "color" TEXT,
    "passengerCapacity" INTEGER,
    "plateProviderRef" TEXT,
    "vinProviderRef" TEXT,
    "insurancePolicyNumber" TEXT,
    "insurancePolicyStatus" TEXT,
    "insurancePolicyExpiresAt" TIMESTAMP(3),
    "insuranceProviderRef" TEXT,
    "status" "ProviderVerificationStatus" NOT NULL DEFAULT 'PROCESSING',
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "carId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsuranceVerification" (
    "id" UUID NOT NULL,
    "carId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "policyNumber" TEXT NOT NULL,
    "policyStatus" TEXT,
    "policyExpiresAt" TIMESTAMP(3),
    "providerRef" TEXT,
    "status" "ProviderVerificationStatus" NOT NULL DEFAULT 'PROCESSING',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsuranceVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChauffeurVerification" (
    "id" UUID NOT NULL,
    "fleetOwnerId" UUID NOT NULL,
    "chauffeurId" UUID,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "invitationIdempotencyKey" TEXT NOT NULL,
    "invitationRequestHash" TEXT NOT NULL,
    "inviteTokenHash" TEXT NOT NULL,
    "inviteExpiresAt" TIMESTAMP(3) NOT NULL,
    "inviteAcceptedAt" TIMESTAMP(3),
    "sessionTokenHash" TEXT,
    "sessionExpiresAt" TIMESTAMP(3),
    "termsAcceptedAt" TIMESTAMP(3),
    "privacyAcceptedAt" TIMESTAMP(3),
    "phoneVerifiedAt" TIMESTAMP(3),
    "ninHash" TEXT,
    "ninLast4" TEXT,
    "identityFirstName" TEXT,
    "identityMiddleName" TEXT,
    "identityLastName" TEXT,
    "identityProviderRef" TEXT,
    "driversLicenseHash" TEXT,
    "driversLicenseLast4" TEXT,
    "driversLicenseExpiresAt" TIMESTAMP(3),
    "driversLicenseProviderRef" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "livenessProviderRef" TEXT,
    "livenessConfidence" DOUBLE PRECISION,
    "faceMatchConfidence" DOUBLE PRECISION,
    "selfieObjectKey" TEXT,
    "status" "ChauffeurVerificationStatus" NOT NULL DEFAULT 'INVITED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChauffeurVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChauffeurVerificationStageRequest" (
    "id" UUID NOT NULL,
    "verificationId" UUID NOT NULL,
    "stage" "ChauffeurVerificationStage" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "ProviderVerificationStatus" NOT NULL DEFAULT 'PROCESSING',
    "failureReason" TEXT,
    "processingExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChauffeurVerificationStageRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "fleetOwnerId" UUID,
    "name" TEXT,
    "phoneNumber" TEXT,
    "fleetOwnerStatus" "FleetOwnerStatus" DEFAULT 'PROCESSING',
    "chauffeurApprovalStatus" "ChauffeurApprovalStatus" DEFAULT 'PENDING',
    "hasOnboarded" BOOLEAN NOT NULL DEFAULT false,
    "referralAttributionSource" "ReferralAttributionSource",
    "referralCode" TEXT,
    "referralDiscountUsed" BOOLEAN NOT NULL DEFAULT false,
    "referralSignupAt" TIMESTAMP(3),
    "referredByUserId" UUID,
    "isOwnerDriver" BOOLEAN NOT NULL DEFAULT false,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "phoneVerifiedAt" TIMESTAMP(3),
    "image" TEXT,
    "termsAcceptedAt" TIMESTAMP(3),
    "privacyAcceptedAt" TIMESTAMP(3),
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "staffRevokedAt" TIMESTAMP(3),
    "chauffeurDisabledAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPushToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPushToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationInbox" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationInboxType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "dedupeKey" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationOutboxEvent" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "eventType" "NotificationOutboxEventType" NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT NOT NULL,
    "bookingId" UUID NOT NULL,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainOutboxEvent" (
    "id" UUID NOT NULL,
    "eventType" "DomainOutboxEventType" NOT NULL,
    "status" "DomainOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "aggregateId" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Flight" (
    "id" UUID NOT NULL,
    "flightNumber" TEXT NOT NULL,
    "flightDate" DATE NOT NULL,
    "faFlightId" TEXT,
    "originCode" TEXT NOT NULL,
    "originCodeIATA" TEXT,
    "originTimezone" TEXT,
    "originName" TEXT,
    "originCity" TEXT,
    "destinationCode" TEXT NOT NULL,
    "destinationCodeIATA" TEXT,
    "destinationName" TEXT,
    "destinationCity" TEXT,
    "scheduledDeparture" TIMESTAMP(3),
    "scheduledArrival" TIMESTAMP(3) NOT NULL,
    "estimatedDeparture" TIMESTAMP(3),
    "estimatedArrival" TIMESTAMP(3),
    "actualDeparture" TIMESTAMP(3),
    "actualArrival" TIMESTAMP(3),
    "status" "FlightStatus" NOT NULL DEFAULT 'SCHEDULED',
    "delayMinutes" INTEGER,
    "aircraftType" TEXT,
    "registration" TEXT,
    "departureGate" TEXT,
    "arrivalGate" TEXT,
    "arrivalTerminal" TEXT,
    "alertId" TEXT,
    "alertEnabled" BOOLEAN NOT NULL DEFAULT false,
    "alertCreatedAt" TIMESTAMP(3),
    "alertDisabledAt" TIMESTAMP(3),
    "alertProvisioningAt" TIMESTAMP(3),
    "alertLastAttemptAt" TIMESTAMP(3),
    "lastUpdated" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataSource" "FlightDataSource" NOT NULL DEFAULT 'FLIGHTAWARE',
    "isLive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Flight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlightStatusEvent" (
    "id" UUID NOT NULL,
    "eventKey" TEXT,
    "flightId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "eventData" JSONB NOT NULL,
    "oldStatus" "FlightStatus",
    "newStatus" "FlightStatus",
    "delayChange" INTEGER,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "notificationsSent" BOOLEAN NOT NULL DEFAULT false,
    "notifiedUserIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlightStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "paymentId" TEXT,
    "carId" UUID NOT NULL,
    "userId" UUID,
    "pickupLocation" TEXT NOT NULL,
    "returnLocation" TEXT NOT NULL,
    "specialRequests" TEXT,
    "chauffeurId" UUID,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" UUID,
    "completionSource" "BookingCompletionSource",
    "completionTokenHash" TEXT,
    "completionTokenExpiresAt" TIMESTAMP(3),
    "airportScheduleConflictAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "guestUser" JSONB,
    "guestAccessTokenHash" TEXT,
    "guestAccessTokenExpiresAt" TIMESTAMP(3),
    "type" "BookingType" NOT NULL DEFAULT 'DAY',
    "paymentIntent" TEXT,
    "paymentSessionExpiresAt" TIMESTAMP(3),
    "paymentReconciliationCheckedAt" TIMESTAMP(3),
    "paymentStatusTokenHash" TEXT,
    "fleetOwnerPayoutAmountNet" DECIMAL(10,2),
    "netTotal" DECIMAL(10,2),
    "overallPayoutStatus" "PayoutTransactionStatus",
    "platformCustomerServiceFeeAmount" DECIMAL(10,2),
    "platformCustomerServiceFeeRatePercent" DECIMAL(5,2),
    "platformFleetOwnerCommissionAmount" DECIMAL(10,2),
    "platformFleetOwnerCommissionRatePercent" DECIMAL(5,2),
    "subtotalBeforeVat" DECIMAL(10,2),
    "vatAmount" DECIMAL(10,2),
    "vatRatePercent" DECIMAL(5,2),
    "bookingReference" TEXT NOT NULL,
    "fuelUpgradeCost" DECIMAL(10,2),
    "referralDiscountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "referralReferrerUserId" UUID,
    "referralStatus" "BookingReferralStatus" NOT NULL DEFAULT 'NONE',
    "referralCreditsUsed" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "referralCreditsReserved" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "flightNumber" TEXT,
    "estimatedDuration" INTEGER,
    "flightId" UUID,
    "deletedAt" TIMESTAMP(3),
    "acquisitionChannel" "BookingAcquisitionChannel" NOT NULL DEFAULT 'GLOBAL',
    "acquisitionPartnerOwnerId" UUID,
    "acquisitionPartnerSlug" TEXT,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingCreationIdempotency" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "customerScope" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "state" "BookingCreationIdempotencyState" NOT NULL DEFAULT 'PROCESSING',
    "bookingId" UUID,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingCreationIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingLeg" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "legDate" DATE NOT NULL,
    "totalDailyPrice" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "legEndTime" TIMESTAMP(3) NOT NULL,
    "legStartTime" TIMESTAMP(3) NOT NULL,
    "fleetOwnerEarningForLeg" DECIMAL(10,2) NOT NULL,
    "itemsNetValueForLeg" DECIMAL(10,2) NOT NULL,
    "platformCommissionAmountOnLeg" DECIMAL(10,2),
    "platformCommissionRateOnLeg" DECIMAL(5,2),

    CONSTRAINT "BookingLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Extension" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "paymentId" TEXT,
    "paymentIntent" TEXT,
    "paymentSessionExpiresAt" TIMESTAMP(3),
    "paymentReconciliationCheckedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "bookingLegId" UUID NOT NULL,
    "eventType" "ExtensionEventType" NOT NULL,
    "extendedDurationHours" INTEGER NOT NULL,
    "extensionEndTime" TIMESTAMP(3) NOT NULL,
    "extensionStartTime" TIMESTAMP(3) NOT NULL,
    "fleetOwnerPayoutAmountNet" DECIMAL(10,2),
    "netTotal" DECIMAL(10,2),
    "overallPayoutStatus" "PayoutTransactionStatus",
    "platformCustomerServiceFeeAmount" DECIMAL(10,2),
    "platformCustomerServiceFeeRatePercent" DECIMAL(5,2),
    "platformFleetOwnerCommissionAmount" DECIMAL(10,2),
    "platformFleetOwnerCommissionRatePercent" DECIMAL(5,2),
    "subtotalBeforeVat" DECIMAL(10,2),
    "vatAmount" DECIMAL(10,2),
    "vatRatePercent" DECIMAL(5,2),

    CONSTRAINT "Extension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionCreationIdempotency" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "customerScope" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "resolvedBookingLegId" UUID NOT NULL,
    "state" "ExtensionCreationIdempotencyState" NOT NULL DEFAULT 'PROCESSING',
    "extensionId" UUID,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtensionCreationIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "bookingId" UUID,
    "extensionId" UUID,
    "txRef" TEXT NOT NULL,
    "flutterwaveTransactionId" TEXT,
    "flutterwaveReference" TEXT,
    "amountExpected" DECIMAL(10,2) NOT NULL,
    "amountCharged" DECIMAL(10,2),
    "currency" TEXT NOT NULL,
    "feeChargedByProvider" DECIMAL(10,2),
    "status" "PaymentAttemptStatus" NOT NULL,
    "paymentProviderStatus" TEXT,
    "paymentMethod" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "webhookPayload" JSONB,
    "verificationResponse" JSONB,
    "refundIdempotencyKey" TEXT,
    "refundProviderId" TEXT,
    "refundProviderStatus" TEXT,
    "refundRequestedAmount" DECIMAL(10,2),
    "refundRequestedAt" TIMESTAMP(3),
    "refundLastCheckedAt" TIMESTAMP(3),
    "refundReconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
    "refundVerificationFailures" INTEGER NOT NULL DEFAULT 0,
    "refundManualReviewNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutTransaction" (
    "id" UUID NOT NULL,
    "fleetOwnerId" UUID NOT NULL,
    "bookingId" UUID,
    "extensionId" UUID,
    "amountToPay" DECIMAL(10,2) NOT NULL,
    "amountPaid" DECIMAL(10,2),
    "currency" TEXT NOT NULL,
    "status" "PayoutTransactionStatus" NOT NULL,
    "payoutProviderReference" TEXT,
    "payoutMethodDetails" TEXT,
    "payoutBankCode" TEXT,
    "payoutAccountLast4" TEXT,
    "processingLeaseId" TEXT,
    "processingLeaseExpiresAt" TIMESTAMP(3),
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "PayoutTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialReconciliationAudit" (
    "id" UUID NOT NULL,
    "resourceType" "FinancialReconciliationResourceType" NOT NULL,
    "resourceId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "outcome" "FinancialReconciliationOutcome" NOT NULL DEFAULT 'STARTED',
    "providerReference" TEXT,
    "providerStatus" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialReconciliationAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentApproval" (
    "id" UUID NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "documentUrl" TEXT NOT NULL,
    "notes" TEXT,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "carId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" UUID,

    CONSTRAINT "DocumentApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleImage" (
    "id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "carId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "notes" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "VehicleImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "overallRating" INTEGER NOT NULL,
    "carRating" INTEGER NOT NULL,
    "chauffeurRating" INTEGER NOT NULL,
    "serviceRating" INTEGER NOT NULL,
    "comment" TEXT,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "moderatedAt" TIMESTAMP(3),
    "moderatedBy" UUID,
    "moderationNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" UUID NOT NULL,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "effectiveSince" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "description" TEXT DEFAULT 'Nigerian VAT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformFeeRate" (
    "id" UUID NOT NULL,
    "feeType" "PlatformFeeType" NOT NULL,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "effectiveSince" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformFeeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Addon" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "bookingTypes" "BookingType"[],
    "pricingUnit" "AddonPricingUnit" NOT NULL,
    "financialTreatment" "AddonFinancialTreatment" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Addon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddonPrice" (
    "id" UUID NOT NULL,
    "addonId" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "effectiveSince" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddonPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingAddon" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "addonId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pricingUnit" "AddonPricingUnit" NOT NULL,
    "financialTreatment" "AddonFinancialTreatment" NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "totalPrice" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingAddon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "carId" UUID,
    "name" TEXT,
    "discountValue" DECIMAL(10,2) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankDetails" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "lastVerifiedAt" TIMESTAMP(3),
    "verificationResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetOwnerAccountVerification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "accountType" "FleetOwnerAccountType" NOT NULL,
    "isOwnerDriver" BOOLEAN,
    "status" "AccountVerificationStatus" NOT NULL DEFAULT 'PROCESSING',
    "processingExpiresAt" TIMESTAMP(3) NOT NULL,
    "identityFirstName" TEXT,
    "identityLastName" TEXT,
    "legalName" TEXT,
    "businessName" TEXT,
    "businessNameMatch" "NameMatchStatus",
    "registrationNumber" TEXT,
    "registrationType" TEXT,
    "identityProviderRef" TEXT,
    "businessProviderRef" TEXT,
    "identityRequiresReview" BOOLEAN NOT NULL DEFAULT false,
    "identityVerifiedAt" TIMESTAMP(3),
    "bankName" TEXT,
    "bankCode" TEXT,
    "accountNumberLast4" TEXT,
    "accountName" TEXT,
    "bankNameMatch" "NameMatchStatus",
    "payoutVerifiedAt" TIMESTAMP(3),
    "representativeNameMatch" "NameMatchStatus",
    "drivingCompletedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetOwnerAccountVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetOwnerAccountVerificationStageRequest" (
    "id" UUID NOT NULL,
    "verificationId" UUID NOT NULL,
    "stage" "AccountVerificationStage" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "ProviderVerificationStatus" NOT NULL DEFAULT 'PROCESSING',
    "failureReason" TEXT,
    "response" JSONB,
    "processingExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetOwnerAccountVerificationStageRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserReferralStats" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,
    "totalReferrals" INTEGER NOT NULL DEFAULT 0,
    "totalRewardsGranted" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalRewardsPending" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lastReferralAt" TIMESTAMP(3),

    CONSTRAINT "UserReferralStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralAttribution" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refereeUserId" UUID NOT NULL,
    "referrerUserId" UUID NOT NULL,
    "referralCode" TEXT NOT NULL,
    "source" "ReferralAttributionSource" NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "sessionId" TEXT,
    "securityFlags" JSONB,

    CONSTRAINT "ReferralAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralReward" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "referrerUserId" UUID NOT NULL,
    "refereeUserId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "ReferralRewardStatus" NOT NULL DEFAULT 'PENDING',
    "releaseCondition" "ReferralReleaseCondition" NOT NULL,
    "reason" TEXT,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ReferralReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralProgramConfig" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "ReferralProgramConfig_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" UUID NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rateLimit" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingDraft" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "status" "BookingDraftStatus" NOT NULL DEFAULT 'NEW',
    "state" JSONB NOT NULL,
    "selectedOptionId" TEXT,
    "quoteExpiresAt" TIMESTAMP(3),
    "checkoutUrl" TEXT,
    "checkoutExpiresAt" TIMESTAMP(3),
    "linkedBookingId" UUID,
    "paymentStatus" "PaymentStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppConversation" (
    "id" UUID NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "waId" TEXT,
    "profileName" TEXT,
    "status" "WhatsAppConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "linkedUserId" UUID,
    "linkStatus" "WhatsAppLinkStatus" NOT NULL DEFAULT 'UNLINKED',
    "linkRequestedAt" TIMESTAMP(3),
    "linkVerifiedAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "windowExpiresAt" TIMESTAMP(3),
    "handoffReason" TEXT,
    "handoffAt" TIMESTAMP(3),
    "activeBookingDraftId" UUID,
    "processingLockToken" TEXT,
    "processingLockExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "providerMessageSid" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "direction" "WhatsAppMessageDirection" NOT NULL,
    "kind" "WhatsAppMessageKind" NOT NULL DEFAULT 'UNKNOWN',
    "status" "WhatsAppMessageStatus" NOT NULL DEFAULT 'RECEIVED',
    "body" TEXT,
    "mediaUrl" TEXT,
    "mediaContentType" TEXT,
    "providerStatus" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "rawPayload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppOutbox" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "mode" "WhatsAppDeliveryMode" NOT NULL,
    "status" "WhatsAppOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "textBody" TEXT,
    "mediaUrl" TEXT,
    "templateName" TEXT,
    "templateVariables" JSONB,
    "payload" JSONB,
    "providerMessageSid" TEXT,
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_RoleToUser" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_RoleToUser_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Car_publicRef_key" ON "Car"("publicRef");

-- CreateIndex
CREATE UNIQUE INDEX "Car_registrationNumber_key" ON "Car"("registrationNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Car_chassisNumber_key" ON "Car"("chassisNumber");

-- CreateIndex
CREATE INDEX "Car_ownerId_idx" ON "Car"("ownerId");

-- CreateIndex
CREATE INDEX "Car_ownerId_updatedAt_idx" ON "Car"("ownerId", "updatedAt");

-- CreateIndex
CREATE INDEX "Car_ownerId_approvalStatus_idx" ON "Car"("ownerId", "approvalStatus");

-- CreateIndex
CREATE INDEX "Car_approvalStatus_idx" ON "Car"("approvalStatus");

-- CreateIndex
CREATE INDEX "Car_status_idx" ON "Car"("status");

-- CreateIndex
CREATE INDEX "Car_updatedAt_dayRate_idx" ON "Car"("updatedAt" DESC, "dayRate");

-- CreateIndex
CREATE INDEX "Car_vehicleType_idx" ON "Car"("vehicleType");

-- CreateIndex
CREATE INDEX "Car_serviceTier_idx" ON "Car"("serviceTier");

-- CreateIndex
CREATE INDEX "Car_serviceTier_vehicleType_idx" ON "Car"("serviceTier", "vehicleType");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleVerification_carId_key" ON "VehicleVerification"("carId");

-- CreateIndex
CREATE INDEX "VehicleVerification_ownerId_plateNumber_idx" ON "VehicleVerification"("ownerId", "plateNumber");

-- CreateIndex
CREATE INDEX "VehicleVerification_status_createdAt_idx" ON "VehicleVerification"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleVerification_ownerId_idempotencyKey_key" ON "VehicleVerification"("ownerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "InsuranceVerification_carId_status_createdAt_idx" ON "InsuranceVerification"("carId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceVerification_ownerId_idempotencyKey_key" ON "InsuranceVerification"("ownerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChauffeurVerification_chauffeurId_key" ON "ChauffeurVerification"("chauffeurId");

-- CreateIndex
CREATE UNIQUE INDEX "ChauffeurVerification_inviteTokenHash_key" ON "ChauffeurVerification"("inviteTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "ChauffeurVerification_sessionTokenHash_key" ON "ChauffeurVerification"("sessionTokenHash");

-- CreateIndex
CREATE INDEX "ChauffeurVerification_fleetOwnerId_status_createdAt_idx" ON "ChauffeurVerification"("fleetOwnerId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChauffeurVerification_owner_invitation_idempotency_key" ON "ChauffeurVerification"("fleetOwnerId", "invitationIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChauffeurVerification_fleetOwnerId_email_key" ON "ChauffeurVerification"("fleetOwnerId", "email");

-- CreateIndex
CREATE INDEX "ChauffeurVerificationStageRequest_verificationId_stage_crea_idx" ON "ChauffeurVerificationStageRequest"("verificationId", "stage", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChauffeurStageRequest_verification_idempotency_key" ON "ChauffeurVerificationStageRequest"("verificationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_fleetOwnerId_idx" ON "User"("fleetOwnerId");

-- CreateIndex
CREATE INDEX "User_fleetOwnerStatus_hasOnboarded_idx" ON "User"("fleetOwnerStatus", "hasOnboarded");

-- CreateIndex
CREATE INDEX "User_hasOnboarded_idx" ON "User"("hasOnboarded");

-- CreateIndex
CREATE INDEX "User_id_email_idx" ON "User"("id", "email");

-- CreateIndex
CREATE INDEX "User_referralCode_idx" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_referredByUserId_idx" ON "User"("referredByUserId");

-- CreateIndex
CREATE INDEX "User_staffRevokedAt_idx" ON "User"("staffRevokedAt");

-- CreateIndex
CREATE INDEX "User_chauffeurDisabledAt_idx" ON "User"("chauffeurDisabledAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserPushToken_token_key" ON "UserPushToken"("token");

-- CreateIndex
CREATE INDEX "UserPushToken_userId_revokedAt_idx" ON "UserPushToken"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "UserPushToken_revokedAt_idx" ON "UserPushToken"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationInbox_dedupeKey_key" ON "NotificationInbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationInbox_userId_readAt_idx" ON "NotificationInbox"("userId", "readAt");

-- CreateIndex
CREATE INDEX "NotificationInbox_createdAt_idx" ON "NotificationInbox"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutboxEvent_dedupeKey_key" ON "NotificationOutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationOutboxEvent_status_nextAttemptAt_idx" ON "NotificationOutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationOutboxEvent_bookingId_idx" ON "NotificationOutboxEvent"("bookingId");

-- CreateIndex
CREATE INDEX "NotificationOutboxEvent_userId_idx" ON "NotificationOutboxEvent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DomainOutboxEvent_dedupeKey_key" ON "DomainOutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "DomainOutbox_status_retry_created_idx" ON "DomainOutboxEvent"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "DomainOutbox_status_updated_idx" ON "DomainOutboxEvent"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "DomainOutboxEvent_aggregateId_idx" ON "DomainOutboxEvent"("aggregateId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Flight_alertId_key" ON "Flight"("alertId");

-- CreateIndex
CREATE INDEX "Flight_flightNumber_flightDate_idx" ON "Flight"("flightNumber", "flightDate");

-- CreateIndex
CREATE INDEX "Flight_status_idx" ON "Flight"("status");

-- CreateIndex
CREATE INDEX "Flight_alertId_idx" ON "Flight"("alertId");

-- CreateIndex
CREATE INDEX "Flight_alertEnabled_alertLastAttemptAt_idx" ON "Flight"("alertEnabled", "alertLastAttemptAt");

-- CreateIndex
CREATE INDEX "Flight_destinationCodeIATA_flightDate_idx" ON "Flight"("destinationCodeIATA", "flightDate");

-- CreateIndex
CREATE INDEX "Flight_scheduledArrival_idx" ON "Flight"("scheduledArrival");

-- CreateIndex
CREATE UNIQUE INDEX "Flight_flightNumber_flightDate_key" ON "Flight"("flightNumber", "flightDate");

-- CreateIndex
CREATE UNIQUE INDEX "FlightStatusEvent_eventKey_key" ON "FlightStatusEvent"("eventKey");

-- CreateIndex
CREATE INDEX "FlightStatusEvent_flightId_eventTime_idx" ON "FlightStatusEvent"("flightId", "eventTime");

-- CreateIndex
CREATE INDEX "FlightStatusEvent_eventType_idx" ON "FlightStatusEvent"("eventType");

-- CreateIndex
CREATE INDEX "FlightStatusEvent_processed_idx" ON "FlightStatusEvent"("processed");

-- CreateIndex
CREATE UNIQUE INDEX "FlightStatusEvent_flightId_eventType_eventTime_key" ON "FlightStatusEvent"("flightId", "eventType", "eventTime");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_guestAccessTokenHash_key" ON "Booking"("guestAccessTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_bookingReference_key" ON "Booking"("bookingReference");

-- CreateIndex
CREATE INDEX "Booking_bookingReference_idx" ON "Booking"("bookingReference");

-- CreateIndex
CREATE INDEX "Booking_carId_idx" ON "Booking"("carId");

-- CreateIndex
CREATE INDEX "Booking_userId_idx" ON "Booking"("userId");

-- CreateIndex
CREATE INDEX "Booking_status_idx" ON "Booking"("status");

-- CreateIndex
CREATE INDEX "Booking_chauffeurId_idx" ON "Booking"("chauffeurId");

-- CreateIndex
CREATE INDEX "Booking_completedByUserId_idx" ON "Booking"("completedByUserId");

-- CreateIndex
CREATE INDEX "Booking_paymentStatus_idx" ON "Booking"("paymentStatus");

-- CreateIndex
CREATE INDEX "Booking_paymentIntent_idx" ON "Booking"("paymentIntent");

-- CreateIndex
CREATE INDEX "Booking_status_paymentStatus_paymentSessionExpiresAt_idx" ON "Booking"("status", "paymentStatus", "paymentSessionExpiresAt");

-- CreateIndex
CREATE INDEX "Booking_overallPayoutStatus_idx" ON "Booking"("overallPayoutStatus");

-- CreateIndex
CREATE INDEX "Booking_startDate_endDate_status_idx" ON "Booking"("startDate", "endDate", "status");

-- CreateIndex
CREATE INDEX "Booking_status_paymentStatus_startDate_idx" ON "Booking"("status", "paymentStatus", "startDate");

-- CreateIndex
CREATE INDEX "Booking_status_paymentStatus_endDate_idx" ON "Booking"("status", "paymentStatus", "endDate");

-- CreateIndex
CREATE INDEX "Booking_chauffeurId_status_startDate_endDate_idx" ON "Booking"("chauffeurId", "status", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "Booking_carId_paymentStatus_status_startDate_endDate_idx" ON "Booking"("carId", "paymentStatus", "status", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "Booking_type_endDate_idx" ON "Booking"("type", "endDate");

-- CreateIndex
CREATE INDEX "Booking_acquisitionChannel_idx" ON "Booking"("acquisitionChannel");

-- CreateIndex
CREATE INDEX "Booking_acquisitionPartnerOwnerId_createdAt_idx" ON "Booking"("acquisitionPartnerOwnerId", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_referralStatus_idx" ON "Booking"("referralStatus");

-- CreateIndex
CREATE INDEX "Booking_referralStatus_status_idx" ON "Booking"("referralStatus", "status");

-- CreateIndex
CREATE INDEX "Booking_userId_paymentStatus_referralCreditsUsed_idx" ON "Booking"("userId", "paymentStatus", "referralCreditsUsed");

-- CreateIndex
CREATE INDEX "Booking_userId_paymentStatus_referralCreditsReserved_idx" ON "Booking"("userId", "paymentStatus", "referralCreditsReserved");

-- CreateIndex
CREATE INDEX "Booking_flightId_idx" ON "Booking"("flightId");

-- CreateIndex
CREATE INDEX "Booking_deletedAt_idx" ON "Booking"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingCreationIdempotency_bookingId_key" ON "BookingCreationIdempotency"("bookingId");

-- CreateIndex
CREATE INDEX "BookingCreationIdempotency_state_createdAt_idx" ON "BookingCreationIdempotency"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingCreationIdempotency_customerScope_idempotencyKey_key" ON "BookingCreationIdempotency"("customerScope", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BookingLeg_bookingId_idx" ON "BookingLeg"("bookingId");

-- CreateIndex
CREATE INDEX "BookingLeg_legDate_idx" ON "BookingLeg"("legDate");

-- CreateIndex
CREATE INDEX "BookingLeg_legDate_legStartTime_idx" ON "BookingLeg"("legDate", "legStartTime");

-- CreateIndex
CREATE INDEX "BookingLeg_legDate_legEndTime_idx" ON "BookingLeg"("legDate", "legEndTime");

-- CreateIndex
CREATE UNIQUE INDEX "BookingLeg_bookingId_legDate_key" ON "BookingLeg"("bookingId", "legDate");

-- CreateIndex
CREATE INDEX "Extension_bookingLegId_idx" ON "Extension"("bookingLegId");

-- CreateIndex
CREATE INDEX "Extension_paymentStatus_idx" ON "Extension"("paymentStatus");

-- CreateIndex
CREATE INDEX "Extension_status_paymentStatus_paymentSessionExpiresAt_idx" ON "Extension"("status", "paymentStatus", "paymentSessionExpiresAt");

-- CreateIndex
CREATE INDEX "Extension_eventType_idx" ON "Extension"("eventType");

-- CreateIndex
CREATE INDEX "Extension_status_idx" ON "Extension"("status");

-- CreateIndex
CREATE INDEX "Extension_overallPayoutStatus_idx" ON "Extension"("overallPayoutStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionCreationIdempotency_extensionId_key" ON "ExtensionCreationIdempotency"("extensionId");

-- CreateIndex
CREATE INDEX "ExtensionCreationIdempotency_state_updatedAt_idx" ON "ExtensionCreationIdempotency"("state", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionCreationIdempotency_customerScope_idempotencyKey_key" ON "ExtensionCreationIdempotency"("customerScope", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_txRef_key" ON "Payment"("txRef");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_flutterwaveTransactionId_key" ON "Payment"("flutterwaveTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_flutterwaveReference_key" ON "Payment"("flutterwaveReference");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_refundIdempotencyKey_key" ON "Payment"("refundIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_refundProviderId_key" ON "Payment"("refundProviderId");

-- CreateIndex
CREATE INDEX "Payment_bookingId_idx" ON "Payment"("bookingId");

-- CreateIndex
CREATE INDEX "Payment_extensionId_idx" ON "Payment"("extensionId");

-- CreateIndex
CREATE INDEX "Payment_txRef_idx" ON "Payment"("txRef");

-- CreateIndex
CREATE INDEX "Payment_flutterwaveTransactionId_idx" ON "Payment"("flutterwaveTransactionId");

-- CreateIndex
CREATE INDEX "Payment_flutterwaveReference_idx" ON "Payment"("flutterwaveReference");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_status_refundRequestedAt_idx" ON "Payment"("status", "refundRequestedAt");

-- CreateIndex
CREATE INDEX "Payment_status_refundManualReviewNotifiedAt_idx" ON "Payment"("status", "refundManualReviewNotifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutTransaction_bookingId_key" ON "PayoutTransaction"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutTransaction_payoutProviderReference_key" ON "PayoutTransaction"("payoutProviderReference");

-- CreateIndex
CREATE INDEX "PayoutTransaction_fleetOwnerId_idx" ON "PayoutTransaction"("fleetOwnerId");

-- CreateIndex
CREATE INDEX "PayoutTransaction_status_idx" ON "PayoutTransaction"("status");

-- CreateIndex
CREATE INDEX "PayoutTransaction_status_initiatedAt_idx" ON "PayoutTransaction"("status", "initiatedAt");

-- CreateIndex
CREATE INDEX "PayoutTransaction_extensionId_idx" ON "PayoutTransaction"("extensionId");

-- CreateIndex
CREATE INDEX "FinancialRecon_resource_created_idx" ON "FinancialReconciliationAudit"("resourceType", "resourceId", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentApproval_status_idx" ON "DocumentApproval"("status");

-- CreateIndex
CREATE INDEX "DocumentApproval_documentType_idx" ON "DocumentApproval"("documentType");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentApproval_documentType_userId_key" ON "DocumentApproval"("documentType", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentApproval_documentType_carId_key" ON "DocumentApproval"("documentType", "carId");

-- CreateIndex
CREATE INDEX "VehicleImage_carId_idx" ON "VehicleImage"("carId");

-- CreateIndex
CREATE INDEX "VehicleImage_status_idx" ON "VehicleImage"("status");

-- CreateIndex
CREATE INDEX "VehicleImage_carId_isPrimary_idx" ON "VehicleImage"("carId", "isPrimary");

-- CreateIndex
CREATE UNIQUE INDEX "Review_bookingId_key" ON "Review"("bookingId");

-- CreateIndex
CREATE INDEX "Review_userId_idx" ON "Review"("userId");

-- CreateIndex
CREATE INDEX "Review_overallRating_idx" ON "Review"("overallRating");

-- CreateIndex
CREATE INDEX "Review_carRating_idx" ON "Review"("carRating");

-- CreateIndex
CREATE INDEX "Review_chauffeurRating_idx" ON "Review"("chauffeurRating");

-- CreateIndex
CREATE INDEX "Review_serviceRating_idx" ON "Review"("serviceRating");

-- CreateIndex
CREATE INDEX "Review_isVisible_idx" ON "Review"("isVisible");

-- CreateIndex
CREATE INDEX "Review_createdAt_idx" ON "Review"("createdAt");

-- CreateIndex
CREATE INDEX "Review_moderatedBy_idx" ON "Review"("moderatedBy");

-- CreateIndex
CREATE UNIQUE INDEX "TaxRate_effectiveSince_key" ON "TaxRate"("effectiveSince");

-- CreateIndex
CREATE INDEX "TaxRate_effectiveSince_effectiveUntil_idx" ON "TaxRate"("effectiveSince", "effectiveUntil");

-- CreateIndex
CREATE INDEX "PlatformFeeRate_feeType_effectiveSince_effectiveUntil_idx" ON "PlatformFeeRate"("feeType", "effectiveSince", "effectiveUntil");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformFeeRate_feeType_effectiveSince_key" ON "PlatformFeeRate"("feeType", "effectiveSince");

-- CreateIndex
CREATE UNIQUE INDEX "Addon_code_key" ON "Addon"("code");

-- CreateIndex
CREATE INDEX "Addon_isActive_idx" ON "Addon"("isActive");

-- CreateIndex
CREATE INDEX "AddonPrice_addonId_effectiveSince_effectiveUntil_idx" ON "AddonPrice"("addonId", "effectiveSince", "effectiveUntil");

-- CreateIndex
CREATE UNIQUE INDEX "AddonPrice_addonId_effectiveSince_key" ON "AddonPrice"("addonId", "effectiveSince");

-- CreateIndex
CREATE INDEX "BookingAddon_addonId_idx" ON "BookingAddon"("addonId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingAddon_bookingId_addonId_key" ON "BookingAddon"("bookingId", "addonId");

-- CreateIndex
CREATE INDEX "Promotion_ownerId_idx" ON "Promotion"("ownerId");

-- CreateIndex
CREATE INDEX "Promotion_carId_idx" ON "Promotion"("carId");

-- CreateIndex
CREATE INDEX "Promotion_isActive_startDate_endDate_idx" ON "Promotion"("isActive", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "Promotion_ownerId_isActive_idx" ON "Promotion"("ownerId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "BankDetails_userId_key" ON "BankDetails"("userId");

-- CreateIndex
CREATE INDEX "FleetOwnerAccountVerification_userId_createdAt_idx" ON "FleetOwnerAccountVerification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "FleetOwnerAccountVerification_status_createdAt_idx" ON "FleetOwnerAccountVerification"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FleetOwnerAccountVerification_reviewedById_idx" ON "FleetOwnerAccountVerification"("reviewedById");

-- CreateIndex
CREATE UNIQUE INDEX "FleetOwnerAccountVerification_userId_idempotencyKey_key" ON "FleetOwnerAccountVerification"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "FleetOwnerAccountVerificationStageRequest_verificationId_st_idx" ON "FleetOwnerAccountVerificationStageRequest"("verificationId", "stage", "createdAt");

-- CreateIndex
CREATE INDEX "FleetOwnerAccountVerificationStageRequest_status_processing_idx" ON "FleetOwnerAccountVerificationStageRequest"("status", "processingExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "FleetOwnerAccountVerificationStageRequest_verificationId_id_key" ON "FleetOwnerAccountVerificationStageRequest"("verificationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "UserReferralStats_userId_key" ON "UserReferralStats"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralAttribution_refereeUserId_key" ON "ReferralAttribution"("refereeUserId");

-- CreateIndex
CREATE INDEX "ReferralAttribution_referrerUserId_idx" ON "ReferralAttribution"("referrerUserId");

-- CreateIndex
CREATE INDEX "ReferralReward_referrerUserId_idx" ON "ReferralReward"("referrerUserId");

-- CreateIndex
CREATE INDEX "ReferralReward_refereeUserId_idx" ON "ReferralReward"("refereeUserId");

-- CreateIndex
CREATE INDEX "ReferralReward_bookingId_idx" ON "ReferralReward"("bookingId");

-- CreateIndex
CREATE INDEX "ReferralReward_status_createdAt_idx" ON "ReferralReward"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReferralReward_status_bookingId_idx" ON "ReferralReward"("status", "bookingId");

-- CreateIndex
CREATE INDEX "ReferralReward_status_processedAt_idx" ON "ReferralReward"("status", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "session_token_idx" ON "session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "verification_value_idx" ON "verification"("value");

-- CreateIndex
CREATE UNIQUE INDEX "rateLimit_key_key" ON "rateLimit"("key");

-- CreateIndex
CREATE INDEX "BookingDraft_conversationId_status_idx" ON "BookingDraft"("conversationId", "status");

-- CreateIndex
CREATE INDEX "BookingDraft_updatedAt_idx" ON "BookingDraft"("updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConversation_phoneE164_key" ON "WhatsAppConversation"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConversation_waId_key" ON "WhatsAppConversation"("waId");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_status_idx" ON "WhatsAppConversation"("status");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_linkedUserId_idx" ON "WhatsAppConversation"("linkedUserId");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_linkStatus_idx" ON "WhatsAppConversation"("linkStatus");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_windowExpiresAt_idx" ON "WhatsAppConversation"("windowExpiresAt");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_processingLockExpiresAt_idx" ON "WhatsAppConversation"("processingLockExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_providerMessageSid_key" ON "WhatsAppMessage"("providerMessageSid");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_dedupeKey_key" ON "WhatsAppMessage"("dedupeKey");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_conversationId_receivedAt_idx" ON "WhatsAppMessage"("conversationId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "WhatsAppMessage_direction_status_idx" ON "WhatsAppMessage"("direction", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppOutbox_dedupeKey_key" ON "WhatsAppOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "WhatsAppOutbox_conversationId_createdAt_idx" ON "WhatsAppOutbox"("conversationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "WhatsAppOutbox_status_nextAttemptAt_idx" ON "WhatsAppOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "_RoleToUser_B_index" ON "_RoleToUser"("B");

-- AddForeignKey
ALTER TABLE "Car" ADD CONSTRAINT "Car_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleVerification" ADD CONSTRAINT "VehicleVerification_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleVerification" ADD CONSTRAINT "VehicleVerification_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceVerification" ADD CONSTRAINT "InsuranceVerification_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceVerification" ADD CONSTRAINT "InsuranceVerification_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChauffeurVerification" ADD CONSTRAINT "ChauffeurVerification_fleetOwnerId_fkey" FOREIGN KEY ("fleetOwnerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChauffeurVerification" ADD CONSTRAINT "ChauffeurVerification_chauffeurId_fkey" FOREIGN KEY ("chauffeurId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChauffeurVerificationStageRequest" ADD CONSTRAINT "ChauffeurVerificationStageRequest_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "ChauffeurVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_fleetOwnerId_fkey" FOREIGN KEY ("fleetOwnerId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredByUserId_fkey" FOREIGN KEY ("referredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPushToken" ADD CONSTRAINT "UserPushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationInbox" ADD CONSTRAINT "NotificationInbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationOutboxEvent" ADD CONSTRAINT "NotificationOutboxEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlightStatusEvent" ADD CONSTRAINT "FlightStatusEvent_flightId_fkey" FOREIGN KEY ("flightId") REFERENCES "Flight"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_acquisitionPartnerOwnerId_fkey" FOREIGN KEY ("acquisitionPartnerOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_chauffeurId_fkey" FOREIGN KEY ("chauffeurId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_flightId_fkey" FOREIGN KEY ("flightId") REFERENCES "Flight"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_referralReferrerUserId_fkey" FOREIGN KEY ("referralReferrerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCreationIdempotency" ADD CONSTRAINT "BookingCreationIdempotency_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingLeg" ADD CONSTRAINT "BookingLeg_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extension" ADD CONSTRAINT "Extension_bookingLegId_fkey" FOREIGN KEY ("bookingLegId") REFERENCES "BookingLeg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionCreationIdempotency" ADD CONSTRAINT "ExtensionCreationIdempotency_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTransaction" ADD CONSTRAINT "PayoutTransaction_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTransaction" ADD CONSTRAINT "PayoutTransaction_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTransaction" ADD CONSTRAINT "PayoutTransaction_fleetOwnerId_fkey" FOREIGN KEY ("fleetOwnerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentApproval" ADD CONSTRAINT "DocumentApproval_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentApproval" ADD CONSTRAINT "DocumentApproval_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentApproval" ADD CONSTRAINT "DocumentApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleImage" ADD CONSTRAINT "VehicleImage_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleImage" ADD CONSTRAINT "VehicleImage_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_moderatedBy_fkey" FOREIGN KEY ("moderatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Addon" ADD CONSTRAINT "Addon_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Addon" ADD CONSTRAINT "Addon_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddonPrice" ADD CONSTRAINT "AddonPrice_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "Addon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddonPrice" ADD CONSTRAINT "AddonPrice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddonPrice" ADD CONSTRAINT "AddonPrice_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAddon" ADD CONSTRAINT "BookingAddon_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAddon" ADD CONSTRAINT "BookingAddon_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "Addon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankDetails" ADD CONSTRAINT "BankDetails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetOwnerAccountVerification" ADD CONSTRAINT "FleetOwnerAccountVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetOwnerAccountVerification" ADD CONSTRAINT "FleetOwnerAccountVerification_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetOwnerAccountVerificationStageRequest" ADD CONSTRAINT "FleetOwnerAccountVerificationStageRequest_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "FleetOwnerAccountVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReferralStats" ADD CONSTRAINT "UserReferralStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_refereeUserId_fkey" FOREIGN KEY ("refereeUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_refereeUserId_fkey" FOREIGN KEY ("refereeUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingDraft" ADD CONSTRAINT "BookingDraft_linkedBookingId_fkey" FOREIGN KEY ("linkedBookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingDraft" ADD CONSTRAINT "BookingDraft_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppConversation" ADD CONSTRAINT "WhatsAppConversation_activeBookingDraftId_fkey" FOREIGN KEY ("activeBookingDraftId") REFERENCES "BookingDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppConversation" ADD CONSTRAINT "WhatsAppConversation_linkedUserId_fkey" FOREIGN KEY ("linkedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppOutbox" ADD CONSTRAINT "WhatsAppOutbox_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RoleToUser" ADD CONSTRAINT "_RoleToUser_A_fkey" FOREIGN KEY ("A") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RoleToUser" ADD CONSTRAINT "_RoleToUser_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Handwritten invariants not expressible in Prisma schema.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_valid_window_check"
CHECK ("startDate" < "endDate");

ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_car_active_window_excl"
EXCLUDE USING gist (
  "carId" WITH =,
  tsrange("startDate", "endDate" + INTERVAL '2 hours', '[)') WITH &&
)
WHERE (
  "deletedAt" IS NULL
  AND "status" IN (
    'PENDING'::"BookingStatus",
    'CONFIRMED'::"BookingStatus",
    'ACTIVE'::"BookingStatus"
  )
);

ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_chauffeur_active_window_excl"
EXCLUDE USING gist (
  "chauffeurId" WITH =,
  tsrange("startDate", "endDate" + INTERVAL '2 hours', '[)') WITH &&
)
WHERE (
  "chauffeurId" IS NOT NULL
  AND "deletedAt" IS NULL
  AND "status" IN (
    'PENDING'::"BookingStatus",
    'CONFIRMED'::"BookingStatus",
    'ACTIVE'::"BookingStatus"
  )
);

ALTER TABLE "Car"
ADD CONSTRAINT "Car_approved_pricing_check"
CHECK (
  "approvalStatus" <> 'APPROVED'
  OR (
    COALESCE("hourlyRate" > 0, false)
    AND COALESCE("dayRate" > 0, false)
    AND COALESCE("nightRate" > 0, false)
    AND COALESCE("fullDayRate" > 0, false)
    AND COALESCE("airportPickupRate" > 0, false)
    AND ("pricingIncludesFuel" OR COALESCE("fuelUpgradeRate" > 0, false))
  )
);

ALTER TABLE "Promotion"
ADD CONSTRAINT "Promotion_discount_nonnegative"
CHECK ("discountValue" >= 0);

ALTER TABLE "Promotion"
ADD CONSTRAINT "Promotion_dates_valid"
CHECK ("endDate" > "startDate");

ALTER TABLE "Promotion"
ADD CONSTRAINT "check_promotion_discount_value"
CHECK ("discountValue" BETWEEN 1 AND 50);

CREATE UNIQUE INDEX "FleetOwnerAccountVerification_one_active_per_user_idx"
ON "FleetOwnerAccountVerification"("userId")
WHERE "status" IN ('DRAFT', 'PROCESSING', 'REVIEW_REQUIRED');

CREATE UNIQUE INDEX "FleetOwnerStageRequest_one_processing_per_stage_idx"
ON "FleetOwnerAccountVerificationStageRequest"("verificationId", "stage")
WHERE "status" = 'PROCESSING';

CREATE UNIQUE INDEX "ChauffeurStageRequest_one_processing_per_stage_idx"
ON "ChauffeurVerificationStageRequest"("verificationId", "stage")
WHERE "status" = 'PROCESSING';

CREATE UNIQUE INDEX "ChauffeurVerification_approved_ninHash_key"
ON "ChauffeurVerification"("ninHash")
WHERE "ninHash" IS NOT NULL
  AND "status" = 'APPROVED'::"ChauffeurVerificationStatus";

CREATE UNIQUE INDEX "ChauffeurVerification_approved_driversLicenseHash_key"
ON "ChauffeurVerification"("driversLicenseHash")
WHERE "driversLicenseHash" IS NOT NULL
  AND "status" = 'APPROVED'::"ChauffeurVerificationStatus";

CREATE INDEX "Booking_unclaimed_guest_email_idx"
ON "Booking" (LOWER("guestUser"->>'email'))
WHERE "userId" IS NULL AND "deletedAt" IS NULL;

-- Required reference data. Fixed UUIDv7 values keep role IDs consistent across
-- fresh environments while application-managed records continue using Prisma defaults.
INSERT INTO "Role" ("id", "name", "description", "createdAt", "updatedAt")
VALUES
  ('01a0a169-4113-77a8-abea-33e8298ee2ec', 'user', 'user role', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('01a0a169-4114-7238-8c3f-79df5258ab78', 'fleetOwner', 'fleetOwner role', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('01a0a169-4114-7238-8c3f-7fe8644d289c', 'admin', 'admin role', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('01a0a169-4114-7238-8c3f-80bdaa62cf0b', 'staff', 'staff role', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('01a0a169-4114-7238-8c3f-87a540db660f', 'chauffeur', 'chauffeur role', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
