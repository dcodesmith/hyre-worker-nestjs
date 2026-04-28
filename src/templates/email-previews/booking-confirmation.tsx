import { BookingConfirmationEmail } from "../emails";
import { sampleBooking } from "./preview-data";

export default function BookingConfirmationPreview() {
  return <BookingConfirmationEmail booking={sampleBooking} />;
}

BookingConfirmationPreview.PreviewProps = {
  booking: sampleBooking,
};
