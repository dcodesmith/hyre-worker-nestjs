import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FlightAwareModule } from "../flightaware/flightaware.module";
import { FlutterwaveModule } from "../flutterwave/flutterwave.module";
import { MapsModule } from "../maps/maps.module";
import { NotificationModule } from "../notification/notification.module";
import { RatesModule } from "../rates/rates.module";
import { BookingController } from "./booking.controller";
import { BookingCalculationService } from "./booking-calculation.service";
import { BookingConfirmationService } from "./booking-confirmation.service";
import { BookingCreationService } from "./booking-creation.service";
import { BookingLegService } from "./booking-leg.service";
import { BookingValidationService } from "./booking-validation.service";

@Module({
  imports: [
    AuthModule,
    NotificationModule,
    RatesModule,
    FlutterwaveModule,
    FlightAwareModule,
    MapsModule,
  ],
  controllers: [BookingController],
  providers: [
    BookingConfirmationService,
    BookingLegService,
    BookingValidationService,
    BookingCalculationService,
    BookingCreationService,
  ],
  exports: [
    BookingConfirmationService,
    BookingLegService,
    BookingValidationService,
    BookingCalculationService,
    BookingCreationService,
  ],
})
export class BookingModule {}
