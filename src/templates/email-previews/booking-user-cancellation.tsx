import { UserBookingCancellationEmail } from "../emails";
import { sampleUserCancellation } from "./preview-data";

export default function BookingUserCancellationPreview() {
  return <UserBookingCancellationEmail booking={sampleUserCancellation} />;
}

BookingUserCancellationPreview.PreviewProps = {
  booking: sampleUserCancellation,
};
