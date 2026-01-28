import { Module } from "@nestjs/common";
import { NotificationModule } from "../notification/notification.module";
import { RatesModule } from "../rates/rates.module";
import { BookingCalculationService } from "./booking-calculation.service";
import { BookingConfirmationService } from "./booking-confirmation.service";
import { BookingLegService } from "./booking-leg.service";
import { BookingValidationService } from "./booking-validation.service";

@Module({
  imports: [NotificationModule, RatesModule],
  providers: [
    BookingConfirmationService,
    BookingLegService,
    BookingValidationService,
    BookingCalculationService,
  ],
  exports: [
    BookingConfirmationService,
    BookingLegService,
    BookingValidationService,
    BookingCalculationService,
  ],
})
export class BookingModule {}
