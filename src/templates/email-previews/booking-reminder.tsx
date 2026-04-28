import type { BookingReminderEmailProps } from "../emails";
import { BookingReminderEmail } from "../emails";
import { sampleBookingLeg } from "./preview-data";

export default function BookingReminderPreview(props: BookingReminderEmailProps) {
  return <BookingReminderEmail {...props} />;
}

BookingReminderPreview.PreviewProps = {
  bookingLeg: sampleBookingLeg,
  recipientType: "client" as const,
  isStartReminder: true,
};
