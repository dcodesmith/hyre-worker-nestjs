import { Module } from "@nestjs/common";
import { NotificationModule } from "../notification/notification.module";
import { BookingConfirmationService } from "./booking-confirmation.service";
import { BookingLegService } from "./booking-leg.service";
import { BookingValidationService } from "./booking-validation.service";

@Module({
  imports: [NotificationModule],
  providers: [BookingConfirmationService, BookingLegService, BookingValidationService],
  exports: [BookingConfirmationService, BookingLegService, BookingValidationService],
})
export class BookingModule {}
