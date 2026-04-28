import type { BookingStatusUpdateEmailProps } from "../emails";
import { BookingStatusUpdateEmail } from "../emails";
import { sampleBookingStatusWithReview } from "./preview-data";

export default function BookingStatusUpdatePreview(props: BookingStatusUpdateEmailProps) {
  return <BookingStatusUpdateEmail {...props} />;
}

BookingStatusUpdatePreview.PreviewProps = {
  booking: sampleBookingStatusWithReview,
};
