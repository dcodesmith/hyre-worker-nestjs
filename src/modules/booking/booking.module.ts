import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EmailModule } from "../email/email.module";
import { FlightAwareModule } from "../flightaware/flightaware.module";
import { FlutterwaveModule } from "../flutterwave/flutterwave.module";
import { MapsModule } from "../maps/maps.module";
import { NotificationModule } from "../notification/notification.module";
import { PromotionModule } from "../promotion/promotion.module";
import { RatesModule } from "../rates/rates.module";
import { BookingController } from "./booking.controller";
import { BookingCalculationService } from "./booking-calculation.service";
import { BookingCancellationService } from "./booking-cancellation.service";
import { BookingConfirmationService } from "./booking-confirmation.service";
import { BookingCreationService } from "./booking-creation.service";
import { BookingCreationIdempotencyService } from "./booking-creation-idempotency.service";
import { BookingEligibilityService } from "./booking-eligibility.service";
import { BookingExtensionService } from "./booking-extension.service";
import { BookingLegService } from "./booking-leg.service";
import { BookingModificationPolicyService } from "./booking-modification-policy.service";
import { BookingPaymentService } from "./booking-payment.service";
import { BookingPersistenceService } from "./booking-persistence.service";
import { BookingPricingPreviewService } from "./booking-pricing-preview.service";
import { BookingReadService } from "./booking-read.service";
import { BookingReservationService } from "./booking-reservation.service";
import { BookingUpdateService } from "./booking-update.service";
import { BookingValidationService } from "./booking-validation.service";
import { ExtensionConfirmationService } from "./extension-confirmation.service";
import { ExtensionCreationIdempotencyService } from "./extension-creation-idempotency.service";
import { ExtensionReservationService } from "./extension-reservation.service";
import { FleetOwnerBookingController } from "./fleet-owner-booking.controller";
import { GuestBookingAccessService } from "./guest-booking-access.service";

@Module({
  imports: [
    AuthModule,
    EmailModule,
    NotificationModule,
    RatesModule,
    FlutterwaveModule,
    FlightAwareModule,
    MapsModule,
    PromotionModule,
  ],
  controllers: [BookingController, FleetOwnerBookingController],
  providers: [
    BookingConfirmationService,
    BookingLegService,
    BookingValidationService,
    BookingCalculationService,
    BookingEligibilityService,
    BookingModificationPolicyService,
    BookingPaymentService,
    BookingPersistenceService,
    BookingCreationIdempotencyService,
    BookingCreationService,
    ExtensionCreationIdempotencyService,
    BookingExtensionService,
    BookingPricingPreviewService,
    BookingReadService,
    BookingReservationService,
    BookingUpdateService,
    BookingCancellationService,
    ExtensionConfirmationService,
    ExtensionReservationService,
    GuestBookingAccessService,
  ],
  exports: [
    BookingConfirmationService,
    BookingLegService,
    BookingValidationService,
    BookingCalculationService,
    BookingEligibilityService,
    BookingPaymentService,
    BookingPersistenceService,
    BookingCreationService,
    BookingExtensionService,
    BookingPricingPreviewService,
    BookingReadService,
    BookingReservationService,
    BookingUpdateService,
    BookingCancellationService,
    ExtensionConfirmationService,
    ExtensionReservationService,
  ],
})
export class BookingModule {}
