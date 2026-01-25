import { Module } from "@nestjs/common";
import { NotificationModule } from "../notification/notification.module";
import { BookingConfirmationService } from "./booking-confirmation.service";

@Module({
  imports: [NotificationModule],
  providers: [BookingConfirmationService],
  exports: [BookingConfirmationService],
})
export class BookingModule {}
